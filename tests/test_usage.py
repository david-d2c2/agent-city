import http.client
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

try:
    from agent_city import usage_import
    from agent_city.server import make_server
    from agent_city.store import Store
    from agent_city.usage_import import import_claude_history
except ImportError:
    Store = None

EMPTY_HISTORY = {'importedAt': None, 'from': None, 'to': None, 'files': 0, 'skipped': 0}
EMPTY = {'since': None, 'liveSince': None, 'skillTracking': False, 'history': EMPTY_HISTORY, 'items': [], 'projectItems': []}
NOW = datetime(2026, 3, 20, 12, 0)


def local_ts(day, hour=12):
    """ISO timestamp with the local offset, so its local day is exactly `day`."""
    year, month, number = map(int, day.split('-'))
    return datetime(year, month, number, hour, 0).astimezone().isoformat()


def call(kind, name, call_id=None, **extra):
    """One assistant transcript block calling the Skill, Task or Agent tool."""
    key = 'skill' if kind == 'Skill' else 'subagent_type'
    return {'type': 'tool_use', 'id': call_id or 'toolu_' + name, 'name': kind, 'input': {key: name, **extra}}


def line(blocks, stamp, **extra):
    entry = {'type': 'assistant', 'timestamp': stamp, 'message': {'role': 'assistant', 'content': blocks}, **extra}
    return json.dumps(entry, separators=(',', ':'))


class UsageCase(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Store, 'Usage tracking is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.store = Store(self.base / 'data')
        self.addCleanup(self.store.close)

    def items(self, **kwargs):
        return {(row['kind'], row['name']): row for row in self.store.usage_summary(**kwargs)['items']}


class StoreUsageTests(UsageCase):
    def test_empty_shape_and_upsert(self):
        self.assertEqual(self.store.usage_summary(today='2026-03-30'), EMPTY)
        for _ in range(2):
            self.assertTrue(self.store.record_usage('claude-code', 'skill', 'frontend-design', day='2026-03-30'))
        self.assertTrue(self.store.record_usage('codex', 'skill', 'frontend-design', day='2026-03-30'))
        self.assertTrue(self.store.record_usage('claude-code', 'agent', 'Explore', day='2026-03-30'))
        summary = self.store.usage_summary(today='2026-03-30')
        self.assertEqual(summary['items'], [
            {'kind': 'skill', 'name': 'frontend-design', 'total': 3, 'last7': 3, 'last30': 3, 'lastAt': '2026-03-30'},
            {'kind': 'agent', 'name': 'Explore', 'total': 1, 'last7': 1, 'last30': 1, 'lastAt': '2026-03-30'}])
        # Sources are separate rows but aggregate per (kind, name).
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM usage').fetchone()[0], 3)

    def test_name_validation_trim_cap_and_case(self):
        for source, kind, name in [('claude-code', 'skill', value) for value in (None, 5, '', '   ', 'a\nb', 'a\x00b', 'a\x7fb', ['x'])] + [('other', 'skill', 'x'), ('claude-code', 'tool', 'x')]:
            self.assertFalse(self.store.record_usage(source, kind, name, day='2026-03-30'), (source, kind, name))
        self.assertEqual(self.store.usage_summary(today='2026-03-30'), EMPTY)
        self.store.record_usage('claude-code', 'agent', '  Ad Creative Strategist  ', day='2026-03-30')
        self.store.record_usage('claude-code', 'agent', 'x' * 130, day='2026-03-30')
        self.store.record_usage('claude-code', 'skill', 'Plug', day='2026-03-30')
        self.store.record_usage('claude-code', 'skill', 'plug', day='2026-03-30')
        names = sorted(name for _, name in self.items(today='2026-03-30'))
        self.assertEqual(names, ['Ad Creative Strategist', 'Plug', 'plug', 'x' * 120])

    def test_windows_since_and_last_at(self):
        today = '2026-03-30'
        for day in ('2026-02-28', '2026-03-01', '2026-03-23', '2026-03-24', '2026-03-30', '2026-03-30'):
            self.store.record_usage('claude-code', 'skill', 'a', day=day)
        row = self.items(today=today)[('skill', 'a')]
        # Last 7 days include today: 03-24..03-30. Last 30: 03-01..03-30.
        self.assertEqual((row['total'], row['last7'], row['last30'], row['lastAt']), (6, 3, 5, '2026-03-30'))
        self.assertEqual(self.store.usage_summary(today=today)['since'], '2026-02-28')
        moved = self.items(today='2026-04-05')[('skill', 'a')]
        self.assertEqual((moved['last7'], moved['last30']), (2, 4))

    def test_order_most_used_first_then_name(self):
        for name, times in (('b', 2), ('a', 2), ('c', 5)):
            for _ in range(times):
                self.store.record_usage('claude-code', 'skill', name, day='2026-03-30')
        self.assertEqual([row['name'] for row in self.store.usage_summary(today='2026-03-30')['items']], ['c', 'a', 'b'])

    def test_live_since_and_skill_tracking_meta(self):
        self.store.record_usage('history', 'skill', 'old', day='2026-01-01')
        summary = self.store.usage_summary(today='2026-03-30')
        self.assertEqual((summary['since'], summary['liveSince'], summary['skillTracking']), ('2026-01-01', None, False))
        self.store.record_usage('claude-code', 'agent', 'Explore', day='2026-03-10')
        summary = self.store.usage_summary(today='2026-03-30')
        self.assertEqual((summary['liveSince'], summary['skillTracking']), ('2026-03-10', False))
        self.store.record_usage('codex', 'skill', 'x', day='2026-03-12')
        self.store.record_usage('claude-code', 'agent', 'Plan', day='2026-03-05')
        summary = self.store.usage_summary(today='2026-03-30')
        self.assertEqual((summary['since'], summary['liveSince'], summary['skillTracking']), ('2026-01-01', '2026-03-10', True))

    def test_clear_removes_rows_and_meta_and_survives_restart(self):
        self.store.record_usage('claude-code', 'skill', 'x', day='2026-03-30')
        self.store.replace_usage_history({('2026-01-01', 'agent', 'Old', ''): 2}, files=1, skipped=0, today='2026-03-30')
        other = Store(self.base / 'data')
        self.addCleanup(other.close)
        self.assertEqual(len(other.usage_summary(today='2026-03-30')['items']), 2)
        other.clear_usage()
        self.assertEqual(self.store.usage_summary(today='2026-03-30'), EMPTY)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM usage_meta').fetchone()[0], 0)

    def test_prune_after_400_days_at_most_once_per_day(self):
        self.store.record_usage('claude-code', 'skill', 'ancient', day='2024-01-01')
        self.store.record_usage('claude-code', 'skill', 'recent', day='2025-06-01')
        self.assertEqual(sorted(name for _, name in self.items(today='2025-06-01')), ['recent'])
        self.store.db.execute("INSERT INTO usage (day, source, kind, name, count) VALUES ('2024-01-02', 'codex', 'skill', 'sneaky', 1)")
        self.store.record_usage('claude-code', 'skill', 'recent', day='2025-06-01')
        self.assertIn(('skill', 'sneaky'), self.items(today='2025-06-01'))
        self.store.record_usage('claude-code', 'skill', 'recent', day='2025-06-02')
        self.assertNotIn(('skill', 'sneaky'), self.items(today='2025-06-02'))
        # The edge of the window is kept.
        self.store.record_usage('claude-code', 'skill', 'edge', day='2024-05-03')
        self.store.record_usage('claude-code', 'skill', 'edge', day='2025-06-07')
        self.assertEqual(self.items(today='2025-06-07')[('skill', 'edge')]['total'], 2)

    def test_items_are_capped_at_five_thousand(self):
        with self.store.db:
            self.store.db.executemany("INSERT INTO usage (day, source, kind, name, count) VALUES ('2026-03-30', 'claude-code', 'skill', ?, ?)", [('s' + str(n).zfill(5), 1 + n % 7) for n in range(5100)])
        items = self.store.usage_summary(today='2026-03-30')['items']
        self.assertEqual(len(items), 5000)
        self.assertEqual(items[0]['total'], 7)
        self.assertEqual([row['total'] for row in items], sorted((row['total'] for row in items), reverse=True))

    def test_organization_state_is_untouched(self):
        before = self.store.bootstrap()['organization']
        self.store.record_usage('claude-code', 'skill', 'x', day='2026-03-30')
        self.store.clear_usage()
        self.assertEqual(self.store.bootstrap()['organization'], before)


class ServerCase(UsageCase):
    def setUp(self):
        super().setUp()
        (self.base / 'web').mkdir()
        (self.base / 'web' / 'index.html').write_text('<!doctype html>City', encoding='utf-8')
        self.server = make_server(self.store, port=0, web_dir=self.base / 'web')
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]
        self.origin = 'http://127.0.0.1:' + str(self.port)
        self.auth = {'Authorization': 'Bearer ' + self.server.ingest_token, 'Content-Type': 'application/json'}

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port)
        self.addCleanup(conn.close)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, dict(response.getheaders()), response.read()

    def ingest(self, event, source='claude-code', headers=None):
        body = json.dumps({'source': source, 'event': {'session_id': 's1', **event}})
        return self.request('POST', '/api/ingest', body, self.auth if headers is None else headers)[0]

    def session(self):
        _, headers, _ = self.request('GET', '/')
        cookie = {'Cookie': headers['Set-Cookie'].split(';')[0], 'Sec-Fetch-Site': 'same-origin'}
        token = json.loads(self.request('GET', '/api/bootstrap', headers=cookie)[2])['csrfToken']
        return cookie, token

    def post(self, path, payload, cookie, token, csrf=True):
        headers = {**cookie, 'Content-Type': 'application/json'}
        if csrf:
            headers.update({'Origin': self.origin, 'X-CSRF-Token': token})
        status, _, data = self.request('POST', path, payload if isinstance(payload, str) else json.dumps(payload), headers)
        return status, json.loads(data)

    def get_usage(self, cookie):
        status, _, data = self.request('GET', '/api/usage', headers=cookie)
        return status, json.loads(data)


class IngestUsageTests(ServerCase):
    def rows(self):
        return self.store.db.execute('SELECT source, kind, name, count FROM usage ORDER BY source, kind, name').fetchall()

    def test_subagent_start_counts_an_agent_and_skill_call_counts_a_skill(self):
        self.assertEqual(self.ingest({'hook_event_name': 'SubagentStart', 'agent_id': 'a1', 'agent_type': 'Explore'}), 204)
        self.assertEqual(self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'plug:frontend-design'}), 204)
        self.assertEqual(self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'plug:frontend-design'}, source='codex'), 204)
        self.assertEqual(self.rows(), [('claude-code', 'agent', 'Explore', 1), ('claude-code', 'skill', 'plug:frontend-design', 1), ('codex', 'skill', 'plug:frontend-design', 1)])
        summary = self.store.usage_summary()
        self.assertTrue(summary['skillTracking'])
        self.assertIsNotNone(summary['liveSince'])
        self.assertEqual(self.server.live.snapshot()['sessions'][0]['sessionId'], 's1')

    def test_other_events_never_count(self):
        for event in (
            {'hook_event_name': 'PostToolUse', 'tool_name': 'Skill', 'skill': 'x'},
            {'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'skill': 'x'},
            {'hook_event_name': 'PreToolUse', 'tool_name': 'Grep', 'agent_id': 'a1', 'agent_type': 'Explore'},
            {'hook_event_name': 'SubagentStop', 'agent_id': 'a1', 'agent_type': 'Explore'},
            {'hook_event_name': 'SubagentStart', 'agent_id': 'a1'},
            {'hook_event_name': 'Stop'},
            {'hook_event_name': 'SessionStart'},
        ):
            self.assertEqual(self.ingest(event), 204, event)
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.store.usage_summary()['skillTracking'], False)

    def test_rejected_requests_do_not_record(self):
        skill = {'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'x'}
        self.assertEqual(self.ingest(skill, headers={'Content-Type': 'application/json'}), 401)
        self.assertEqual(self.ingest(skill, headers={**self.auth, 'Authorization': 'Bearer nope'}), 401)
        self.assertEqual(self.ingest(skill, headers={**self.auth, 'Origin': self.origin}), 403)
        self.assertEqual(self.ingest(dict(skill, skill='bad name')), 400)
        self.assertEqual(self.ingest(dict(skill, skill=5)), 400)
        self.assertEqual(self.ingest(skill, source='other'), 400)
        self.assertEqual(self.ingest({'hook_event_name': 'SubagentStart', 'agent_type': 'x' * 301}), 400)
        self.assertEqual(self.rows(), [])

    def test_storage_failure_never_fails_the_hook(self):
        self.store.db.execute("CREATE TRIGGER no_usage BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        self.assertEqual(self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'x'}), 204)
        self.assertEqual(self.ingest({'hook_event_name': 'SubagentStart', 'agent_id': 'a1', 'agent_type': 'Explore'}), 204)
        self.assertEqual(self.rows(), [])
        self.assertEqual(len(self.server.live.snapshot()['sessions']), 2)
        self.store.db.execute('DROP TRIGGER no_usage')
        self.store.db.execute('DROP TABLE usage')
        self.assertEqual(self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'x'}), 204)

    def test_tool_input_content_never_reaches_storage(self):
        event = {'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'x', 'tool_input': {'skill': 'y', 'args': 'SECRET ARGS'}, 'prompt': 'SECRET PROMPT'}
        self.assertEqual(self.ingest(event), 204)
        dump = json.dumps(self.store.db.execute('SELECT * FROM usage').fetchall() + self.store.db.execute('SELECT * FROM usage_meta').fetchall())
        self.assertNotIn('SECRET', dump)
        self.assertEqual(self.rows(), [('claude-code', 'skill', 'x', 1)])


class EndpointTests(ServerCase):
    def fake_home(self, lines=()):
        home = self.base / 'home'
        project = home / '.claude' / 'projects' / 'proj-one'
        project.mkdir(parents=True)
        (project / 'session.jsonl').write_text('\n'.join(lines) + '\n', encoding='utf-8')
        return home

    def test_get_usage_requires_a_session_and_returns_the_shape(self):
        self.assertEqual(self.request('GET', '/api/usage')[0], 403)
        self.assertEqual(self.request('GET', '/api/usage', headers=self.auth)[0], 403)
        cookie, token = self.session()
        self.assertEqual(self.get_usage(cookie), (200, EMPTY))
        self.assertEqual(self.request('GET', '/api/usage', headers={**cookie, 'Origin': 'https://evil.example'})[0], 403)
        self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'x'})
        status, usage = self.get_usage(cookie)
        today = datetime.now().date().isoformat()
        self.assertEqual(status, 200)
        self.assertEqual(usage['items'], [{'kind': 'skill', 'name': 'x', 'total': 1, 'last7': 1, 'last30': 1, 'lastAt': today}])
        self.assertEqual((usage['since'], usage['liveSince'], usage['skillTracking']), (today, today, True))
        self.assertNotIn('csrfToken', usage)
        self.assertNotIn('usage', self.store.bootstrap())

    def test_clear_requires_csrf_and_resets(self):
        cookie, token = self.session()
        self.ingest({'hook_event_name': 'SubagentStart', 'agent_id': 'a', 'agent_type': 'Explore'})
        self.assertEqual(self.post('/api/usage/clear', {}, cookie, token, csrf=False)[0], 403)
        self.assertEqual(len(self.get_usage(cookie)[1]['items']), 1)
        for payload in ('[]', '{"extra":1}', '['):
            self.assertEqual(self.post('/api/usage/clear', payload, cookie, token)[0], 400, payload)
        self.assertEqual(self.request('GET', '/api/usage/clear', headers=cookie)[0], 404)
        self.assertEqual(self.post('/api/usage/clear', {}, cookie, token), (200, EMPTY))
        self.assertEqual(self.get_usage(cookie), (200, EMPTY))

    def test_import_history_endpoint(self):
        cookie, token = self.session()
        lines = [line([call('Skill', 'frontend-design'), call('Task', 'Explore', 't2')], local_ts('2026-03-10'))]
        with mock.patch('agent_city.usage_import.Path.home', return_value=self.base / 'nobody'):
            status, data = self.post('/api/usage/import-history', {}, cookie, token)
            self.assertEqual((status, data), (400, {'error': 'No se encontró el historial de Claude Code.'}))
        home = self.fake_home(lines)
        with mock.patch('agent_city.usage_import.Path.home', return_value=home):
            self.assertEqual(self.post('/api/usage/import-history', {}, cookie, token, csrf=False)[0], 403)
            for payload in ('[]', '{"path":"C:/"}', '['):
                self.assertEqual(self.post('/api/usage/import-history', payload, cookie, token)[0], 400, payload)
            self.assertEqual(self.get_usage(cookie)[1], EMPTY)
            status, data = self.post('/api/usage/import-history', {}, cookie, token)
        self.assertEqual(status, 200)
        self.assertEqual(set(data), {'imported', 'usage'})
        self.assertEqual({key: data['imported'][key] for key in ('agent', 'skill', 'files', 'skipped', 'from', 'to')}, {'agent': 1, 'skill': 1, 'files': 1, 'skipped': 0, 'from': '2026-03-10', 'to': '2026-03-10'})
        usage = data['usage']
        self.assertEqual(sorted((row['kind'], row['name'], row['total']) for row in usage['items']), [('agent', 'Explore', 1), ('skill', 'frontend-design', 1)])
        self.assertEqual((usage['since'], usage['liveSince'], usage['skillTracking']), ('2026-03-10', None, False))
        self.assertEqual({key: usage['history'][key] for key in ('from', 'to', 'files', 'skipped')}, {'from': '2026-03-10', 'to': '2026-03-10', 'files': 1, 'skipped': 0})
        self.assertIsInstance(usage['history']['importedAt'], str)
        self.assertEqual(self.get_usage(cookie)[1], usage)
        self.assertEqual(self.post('/api/usage/clear', {}, cookie, token), (200, EMPTY))


class ImportTests(UsageCase):
    def setUp(self):
        super().setUp()
        self.projects = self.base / 'projects'
        self.projects.mkdir()

    def transcript(self, relative, lines):
        path = self.projects / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        return path

    def run_import(self, **kwargs):
        return import_claude_history(self.store, projects_dir=self.projects, now=NOW, **kwargs)

    def counts(self):
        return {(row[0], row[1], row[2]): row[3] for row in self.store.db.execute("SELECT day, kind, name, count FROM usage WHERE source='history'")}

    def test_counts_by_local_day_across_nested_files(self):
        self.transcript('proj-a/one.jsonl', [
            line([call('Skill', 'frontend-design', 't1'), call('Task', 'Explore', 't2')], local_ts('2026-03-10')),
            line([call('Agent', 'Plan', 't3')], local_ts('2026-03-10', 23)),
            line([call('Skill', 'plug:other', 't4')], local_ts('2026-03-11', 0)),
            line([{'type': 'text', 'text': 'hello'}], local_ts('2026-03-11')),
        ])
        self.transcript('proj-a/subagents/two.jsonl', [line([call('Skill', 'frontend-design', 't5')], local_ts('2026-03-10', 1))])
        self.transcript('proj-b/three.jsonl', [line([call('Task', 'Explore', 't6')], local_ts('2026-03-12'))])
        (self.projects / 'proj-b' / 'notes.txt').write_text(line([call('Skill', 'ignored-extension', 't7')], local_ts('2026-03-12')), encoding='utf-8')
        result = self.run_import()
        self.assertEqual(self.counts(), {
            ('2026-03-10', 'skill', 'frontend-design'): 2, ('2026-03-10', 'agent', 'Explore'): 1, ('2026-03-10', 'agent', 'Plan'): 1,
            ('2026-03-11', 'skill', 'plug:other'): 1, ('2026-03-12', 'agent', 'Explore'): 1})
        self.assertEqual(result, {'agent': 3, 'skill': 3, 'files': 3, 'skipped': 0, 'from': '2026-03-10', 'to': '2026-03-12', 'partial': False})

    def test_zulu_timestamps_become_local_days(self):
        stamp = '2026-03-10T23:30:00.000Z'
        expected = datetime(2026, 3, 10, 23, 30, tzinfo=timezone.utc).astimezone().date().isoformat()
        self.transcript('p/a.jsonl', [line([call('Skill', 'x')], stamp)])
        self.run_import()
        self.assertEqual(list(self.counts()), [(expected, 'skill', 'x')])

    def test_ignores_everything_that_is_not_a_valid_call(self):
        stamp = local_ts('2026-03-10')
        junk = [
            'not json at all "name":"Skill"',
            '["name":"Skill"]',
            '[{"name":"Skill"}]',
            '{"name":"Skill"}',
            '{"message":"x","name":"Skill"}',
            json.dumps({'timestamp': stamp, 'message': {'content': 'free text "name":"Skill" here'}}, separators=(',', ':')),
            line([{'type': 'text', 'name': 'Skill', 'input': {'skill': 'fake'}}], stamp),
            line([{'type': 'tool_use', 'name': 'Skill', 'input': {'skill': 'bad name!'}}], stamp),
            line([{'type': 'tool_use', 'name': 'Skill', 'input': {'skill': 'x' * 121}}], stamp),
            line([{'type': 'tool_use', 'name': 'Skill', 'input': {'skill': 5}}], stamp),
            line([{'type': 'tool_use', 'name': 'Skill', 'input': 'frontend-design'}], stamp),
            line([{'type': 'tool_use', 'name': 'Skill', 'input': {}}], stamp),
            line([{'type': 'tool_use', 'name': 'Task', 'input': {'description': 'no type'}}], stamp),
            line([{'type': 'tool_use', 'name': 'Task', 'input': {'subagent_type': 'a\nb'}}], stamp),
            line([{'type': 'tool_use', 'name': 'Task', 'input': {'subagent_type': '   '}}], stamp),
            line([call('Skill', 'no-timestamp')], None),
            line([call('Skill', 'bad-timestamp')], 'yesterday'),
            line([call('Skill', 'number-timestamp')], 17),
            json.dumps({'message': {'content': [call('Skill', 'missing-timestamp')]}}, separators=(',', ':')),
            json.dumps({'timestamp': stamp, 'message': {'content': {'name': 'Skill'}}}, separators=(',', ':')),
        ]
        self.transcript('p/junk.jsonl', junk + [line([call('Skill', 'good')], stamp)])
        result = self.run_import()
        self.assertEqual(self.counts(), {('2026-03-10', 'skill', 'good'): 1})
        self.assertEqual((result['skill'], result['agent'], result['skipped']), (1, 0, 0))

    def test_only_lines_with_a_marker_are_parsed(self):
        stamp = local_ts('2026-03-10')
        lines = [
            json.dumps({'type': 'user', 'timestamp': stamp, 'message': {'content': 'SECRET PROMPT ' + str(n)}}, separators=(',', ':')) for n in range(5)
        ] + [line([call('Skill', 'x')], stamp)]
        self.transcript('p/a.jsonl', lines)
        real = usage_import.json.loads
        with mock.patch('agent_city.usage_import.json.loads', side_effect=real) as spy:
            self.run_import()
        # Only the compact call line is parsed; the five marker-less lines never are.
        self.assertEqual(spy.call_count, 1)
        self.assertEqual(list(self.counts()), [('2026-03-10', 'skill', 'x')])

    def test_repeated_tool_call_ids_from_resumed_sessions_count_once(self):
        stamp = local_ts('2026-03-10')
        self.transcript('p/a.jsonl', [line([call('Skill', 'x', 'toolu_same')], stamp)])
        self.transcript('p/b.jsonl', [line([call('Skill', 'x', 'toolu_same')], stamp), line([call('Skill', 'x', 'toolu_other')], stamp)])
        self.run_import()
        self.assertEqual(self.counts(), {('2026-03-10', 'skill', 'x'): 2})

    def test_idempotent_and_replaces_previous_history(self):
        stamp = local_ts('2026-03-10')
        path = self.transcript('p/a.jsonl', [line([call('Skill', 'x', 't1'), call('Skill', 'x', 't2')], stamp)])
        first = self.run_import()
        summary = self.store.usage_summary(today='2026-03-20')
        self.assertEqual(self.run_import(), first)
        self.assertEqual(self.store.usage_summary(today='2026-03-20')['items'], summary['items'])
        self.assertEqual(self.counts(), {('2026-03-10', 'skill', 'x'): 2})
        path.write_text(line([call('Skill', 'y', 't3')], stamp) + '\n', encoding='utf-8')
        self.run_import()
        self.assertEqual(self.counts(), {('2026-03-10', 'skill', 'y'): 1})

    def test_history_stops_before_the_first_live_day(self):
        calls = [call('Skill', 'x', 't' + str(day)) for day in (10, 11, 12, 13)]
        self.transcript('p/a.jsonl', [line([block], local_ts('2026-03-' + str(day))) for block, day in zip(calls, (10, 11, 12, 13))])
        self.store.record_usage('claude-code', 'skill', 'x', day='2026-03-12')
        result = self.run_import()
        self.assertEqual(self.counts(), {('2026-03-10', 'skill', 'x'): 1, ('2026-03-11', 'skill', 'x'): 1})
        self.assertEqual((result['skill'], result['from'], result['to']), (2, '2026-03-10', '2026-03-11'))
        row = self.items(today='2026-03-20')[('skill', 'x')]
        self.assertEqual((row['total'], row['lastAt']), (3, '2026-03-12'))
        # A re-run keeps the same cut.
        self.run_import()
        self.assertEqual(len(self.counts()), 2)

    def test_everything_live_leaves_no_history(self):
        self.transcript('p/a.jsonl', [line([call('Skill', 'x')], local_ts('2026-03-10'))])
        self.store.record_usage('claude-code', 'skill', 'x', day='2026-03-01')
        result = self.run_import()
        self.assertEqual((self.counts(), result['skill'], result['from'], result['to']), ({}, 0, None, None))
        self.assertEqual(self.store.usage_summary(today='2026-03-20')['history']['from'], None)

    def test_days_outside_the_retention_window_are_dropped(self):
        self.transcript('p/a.jsonl', [line([call('Skill', 'old', 't1')], local_ts('2025-01-01')), line([call('Skill', 'kept', 't2')], local_ts('2025-02-14'))])
        self.run_import()
        self.assertEqual(list(self.counts()), [('2025-02-14', 'skill', 'kept')])

    def test_limits_skips_and_budget(self):
        stamp = local_ts('2026-03-10')
        big = self.transcript('p/big.jsonl', [line([call('Skill', 'big', 't1')], stamp)])
        for name in ('a', 'b', 'c'):
            self.transcript('p/' + name + '.jsonl', [line([call('Skill', name, 't' + name)], stamp)])
        result = self.run_import(max_file_bytes=big.stat().st_size - 1)
        self.assertEqual((result['files'], result['skipped'], result['partial']), (3, 1, False))
        self.assertEqual(len(self.counts()), 3)
        result = self.run_import(max_files=2)
        self.assertEqual((result['files'] + result['skipped'], result['partial']), (2, True))
        result = self.run_import(budget_seconds=-1)
        self.assertEqual((result['files'], result['partial'], self.counts()), (0, True, {}))
        result = self.run_import()
        self.assertEqual((result['files'], result['partial'], len(self.counts())), (4, False, 4))
        stored = self.store.usage_summary(today='2026-03-20')['history']
        self.assertEqual((stored['files'], stored['skipped'], stored['from'], stored['to']), (4, 0, '2026-03-10', '2026-03-10'))

    def test_unreadable_files_are_skipped_and_do_not_stop_the_import(self):
        stamp = local_ts('2026-03-10')
        self.transcript('p/locked.jsonl', [line([call('Skill', 'locked', 't1')], stamp)])
        self.transcript('p/open.jsonl', [line([call('Skill', 'open', 't2')], stamp)])
        real = open

        def guarded(path, *args, **kwargs):
            if str(path).endswith('locked.jsonl'):
                raise PermissionError('no')
            return real(path, *args, **kwargs)

        with mock.patch('agent_city.usage_import.open', side_effect=guarded, create=True):
            result = self.run_import()
        self.assertEqual((result['files'], result['skipped']), (1, 1))
        self.assertEqual(list(self.counts()), [('2026-03-10', 'skill', 'open')])

    def test_links_are_not_followed(self):
        stamp = local_ts('2026-03-10')
        outside = self.base / 'outside'
        self.transcript('p/real.jsonl', [line([call('Skill', 'real', 't1')], stamp)])
        (outside).mkdir()
        (outside / 'secret.jsonl').write_text(line([call('Skill', 'outside', 't2')], stamp) + '\n', encoding='utf-8')
        try:
            (self.projects / 'linked-dir').symlink_to(outside, target_is_directory=True)
            (self.projects / 'p' / 'linked-file.jsonl').symlink_to(outside / 'secret.jsonl')
        except OSError:
            self.skipTest('symbolic links are not available')
        self.run_import()
        self.assertEqual(list(self.counts()), [('2026-03-10', 'skill', 'real')])

    def test_missing_directory_raises_a_generic_error(self):
        (self.base / 'file.txt').write_text('x', encoding='utf-8')
        for target in (self.base / 'nowhere', self.base / 'file.txt'):
            with self.assertRaises(ValueError) as raised:
                import_claude_history(self.store, projects_dir=target, now=NOW)
            self.assertEqual(str(raised.exception), 'No se encontró el historial de Claude Code.')
        with mock.patch('agent_city.usage_import.Path.home', return_value=self.base / 'empty-home'):
            with self.assertRaises(ValueError):
                import_claude_history(self.store, now=NOW)

    def test_nothing_but_names_and_counts_is_stored_or_returned(self):
        stamp = local_ts('2026-03-10')
        self.transcript('secret-client-folder/SECRET-FILE.jsonl', [
            line([call('Skill', 'x', 't1', args='SECRET ARGS'), {'type': 'text', 'text': 'SECRET PROMPT'}], stamp, cwd='C:/secret/cwd', sessionId='SECRET-SESSION'),
            json.dumps({'type': 'user', 'timestamp': stamp, 'message': {'content': 'SECRET PROMPT 2'}}, separators=(',', ':')),
        ])
        result = self.run_import()
        tables = [self.store.db.execute('SELECT * FROM ' + table).fetchall() for table in ('usage', 'usage_meta')]
        dump = json.dumps([result, tables, self.store.usage_summary(today='2026-03-20')])
        for secret in ('SECRET', 'secret', 'cwd', 'toolu', self.base.name, 'projects'):
            self.assertNotIn(secret, dump)


if __name__ == '__main__':
    unittest.main()
