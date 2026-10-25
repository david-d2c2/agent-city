"""Per-project usage attribution: schema migration, folder resolver, live ingest, history import and API shape."""
import json
from pathlib import Path
import sqlite3
import unittest
from unittest import mock

import test_usage as base

try:
    from agent_city.store import Store
    from agent_city.usage_import import import_claude_history
except ImportError:
    Store = None

OLD_SHAPE = 'CREATE TABLE usage (day TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, source, kind, name))'
PROJECT_ROOT = 'C:\\Work\\Proj'


def register(store, *projects):
    """Replace the organization's projects with (id, name, path-or-None) rows."""
    organization = store.bootstrap()['organization']
    organization['projects'] = [{'id': identity, 'name': name, 'spaceIds': ['office'], **({'path': path} if path is not None else {})} for identity, name, path in projects]
    return store.save_organization(organization)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Store, 'Usage tracking is not implemented')
        import tempfile
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def old_database(self):
        db = sqlite3.connect(self.directory / 'agent-city.sqlite3')
        db.execute(OLD_SHAPE)
        db.execute('CREATE TABLE usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        db.executemany('INSERT INTO usage VALUES (?, ?, ?, ?, ?)', [
            ('2026-01-05', 'history', 'skill', 'old-skill', 4), ('2026-01-06', 'history', 'agent', 'Explore', 2),
            ('2026-03-10', 'claude-code', 'agent', 'Explore', 3), ('2026-03-10', 'codex', 'skill', 'plug:x', 1)])
        db.executemany('INSERT INTO usage_meta VALUES (?, ?)', [('liveSince', '2026-03-10'), ('skillTracking', '1'), ('history', json.dumps({'importedAt': 'T', 'from': '2026-01-05', 'to': '2026-01-06', 'files': 2, 'skipped': 0}))])
        db.commit()
        db.close()

    def columns(self, store):
        return [row[1] for row in store.db.execute('PRAGMA table_info(usage)')]

    def test_old_database_keeps_every_row_and_gains_the_project_column(self):
        self.old_database()
        store = Store(self.directory)
        self.addCleanup(store.close)
        self.assertEqual(self.columns(store), ['day', 'source', 'kind', 'name', 'project', 'count'])
        rows = store.db.execute('SELECT day, source, kind, name, project, count FROM usage ORDER BY day, source, kind, name').fetchall()
        self.assertEqual(rows, [
            ('2026-01-05', 'history', 'skill', 'old-skill', '', 4), ('2026-01-06', 'history', 'agent', 'Explore', '', 2),
            ('2026-03-10', 'claude-code', 'agent', 'Explore', '', 3), ('2026-03-10', 'codex', 'skill', 'plug:x', '', 1)])
        summary = store.usage_summary(today='2026-03-20')
        self.assertEqual((summary['since'], summary['liveSince'], summary['skillTracking']), ('2026-01-05', '2026-03-10', True))
        self.assertEqual(summary['history']['files'], 2)
        self.assertEqual({(row['kind'], row['name']): row['total'] for row in summary['items']}, {('skill', 'old-skill'): 4, ('agent', 'Explore'): 5, ('skill', 'plug:x'): 1})
        self.assertEqual(summary['projectItems'], [])
        self.assertTrue((self.directory / 'agent-city.pre-project-usage.sqlite3').exists())
        # The rebuilt table accepts attributed rows next to the legacy ones.
        self.assertTrue(store.record_usage('claude-code', 'agent', 'Explore', day='2026-03-10', project='p1'))
        self.assertEqual(store.db.execute("SELECT COUNT(*) FROM usage WHERE name='Explore' AND day='2026-03-10'").fetchone()[0], 2)

    def test_migration_is_idempotent_and_a_fresh_database_gets_the_new_shape(self):
        self.old_database()
        first = Store(self.directory)
        first.record_usage('claude-code', 'skill', 'new', day='2026-03-11', project='p1')
        before = first.db.execute('SELECT * FROM usage ORDER BY day, source, kind, name, project').fetchall()
        first.close()
        (self.directory / 'agent-city.pre-project-usage.sqlite3').unlink()
        second = Store(self.directory)
        self.addCleanup(second.close)
        self.assertEqual(second.db.execute('SELECT * FROM usage ORDER BY day, source, kind, name, project').fetchall(), before)
        self.assertFalse((self.directory / 'agent-city.pre-project-usage.sqlite3').exists())
        fresh = Store(self.directory / 'fresh')
        self.addCleanup(fresh.close)
        self.assertEqual(self.columns(fresh), ['day', 'source', 'kind', 'name', 'project', 'count'])
        self.assertFalse((self.directory / 'fresh' / 'agent-city.pre-project-usage.sqlite3').exists())

    def test_failed_migration_rolls_back_and_leaves_the_old_table(self):
        self.old_database()
        db = sqlite3.connect(self.directory / 'agent-city.sqlite3')
        db.execute('CREATE TABLE usage_new (x)')
        db.commit()
        db.close()
        with self.assertRaises(sqlite3.Error):
            Store(self.directory)
        db = sqlite3.connect(self.directory / 'agent-city.sqlite3')
        self.addCleanup(db.close)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM usage').fetchone()[0], 4)
        self.assertNotIn('project', [row[1] for row in db.execute('PRAGMA table_info(usage)')])


class ResolverTests(base.UsageCase):
    def test_whole_segments_case_slashes_and_trailing_separators(self):
        register(self.store, ('p1', 'Proj', PROJECT_ROOT + '\\'))
        match = self.store.project_for_cwd
        for cwd in (PROJECT_ROOT, 'c:\\work\\PROJ', 'C:/Work/Proj', 'C:/Work/Proj/', 'c:/work/proj//', 'C:\\Work\\Proj\\sub\\deep', '  C:\\Work\\Proj  '):
            self.assertEqual(match(cwd), 'p1', cwd)
        for cwd in ('C:\\Work\\Proj-other', 'C:\\Work\\Project', 'C:\\Work', 'C:\\Work\\Pro', 'D:\\Work\\Proj', '', '   ', None, 5, ['C:\\Work\\Proj']):
            self.assertEqual(match(cwd), '', cwd)

    def test_longest_registered_folder_wins_and_pathless_projects_never_match(self):
        register(self.store, ('outer', 'Outer', 'C:\\Work'), ('inner', 'Inner', 'C:\\Work\\Proj\\apps'), ('mid', 'Mid', 'C:\\Work\\Proj'),
                 ('none', 'No folder', None), ('blank', 'Blank folder', ''), ('root', 'Root', '/'), ('slash', 'Slashes', '///'))
        match = self.store.project_for_cwd
        self.assertEqual(match('C:\\Work\\Proj\\apps\\web'), 'inner')
        self.assertEqual(match('C:\\Work\\Proj\\apps'), 'inner')
        self.assertEqual(match('C:\\Work\\Proj\\libs'), 'mid')
        self.assertEqual(match('C:\\Work\\Elsewhere'), 'outer')
        self.assertEqual(match('/home/someone'), '')
        self.assertEqual(match('D:\\Other'), '')

    def test_cache_is_reused_and_invalidated_by_save_undo_and_other_connections(self):
        register(self.store, ('p1', 'One', 'C:\\Work\\One'))
        real = self.store._load
        with mock.patch.object(self.store, '_load', side_effect=real) as spy:
            for _ in range(50):
                self.assertEqual(self.store.project_for_cwd('C:\\Work\\One\\x'), 'p1')
            self.assertEqual(spy.call_count, 1)
        register(self.store, ('p2', 'Two', 'C:\\Work\\One'))
        self.assertEqual(self.store.project_for_cwd('C:\\Work\\One'), 'p2')
        self.store.undo()
        self.assertEqual(self.store.project_for_cwd('C:\\Work\\One'), 'p1')
        other = Store(self.base / 'data')
        self.addCleanup(other.close)
        register(other, ('p3', 'Three', 'C:\\Work\\One'))
        self.assertEqual(self.store.project_for_cwd('C:\\Work\\One'), 'p3')

    def test_record_usage_rejects_a_malformed_project(self):
        for project in ('C:\\Work\\Proj', 'a b', 'x' * 101, None, 5):
            self.assertFalse(self.store.record_usage('claude-code', 'skill', 'x', day='2026-03-30', project=project), project)
        self.assertEqual(self.store.usage_summary(today='2026-03-30')['items'], [])


class IngestProjectTests(base.ServerCase):
    def setUp(self):
        super().setUp()
        register(self.store, ('p1', 'Proj', PROJECT_ROOT), ('p2', 'Other', 'C:\\Work\\Other'), ('p3', 'Nowhere', None))

    def rows(self):
        return self.store.db.execute('SELECT kind, name, project, count FROM usage ORDER BY kind, name, project').fetchall()

    def test_event_cwd_decides_the_project(self):
        skill = {'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'plug:one'}
        self.assertEqual(self.ingest({**skill, 'cwd': 'c:/work/proj/web'}), 204)
        self.assertEqual(self.ingest({**skill, 'cwd': PROJECT_ROOT}), 204)
        self.assertEqual(self.ingest({**skill, 'cwd': 'C:\\Work\\Other'}), 204)
        self.assertEqual(self.ingest({**skill, 'cwd': 'C:\\Work\\Proj-other'}), 204)
        self.assertEqual(self.ingest({'hook_event_name': 'SubagentStart', 'agent_id': 'a1', 'agent_type': 'Explore', 'cwd': PROJECT_ROOT + '\\api'}), 204)
        self.assertEqual(self.rows(), [('agent', 'Explore', 'p1', 1), ('skill', 'plug:one', '', 1), ('skill', 'plug:one', 'p1', 2), ('skill', 'plug:one', 'p2', 1)])

    def test_missing_cwd_falls_back_to_the_session_last_known_folder(self):
        self.assertEqual(self.ingest({'hook_event_name': 'SessionStart', 'cwd': PROJECT_ROOT}), 204)
        self.assertEqual(self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'x'}), 204)
        self.assertEqual(self.ingest({'hook_event_name': 'SubagentStart', 'agent_id': 'a1', 'agent_type': 'Plan'}), 204)
        # Another session never inherits that folder; a session that moved uses the newest one.
        self.assertEqual(self.request('POST', '/api/ingest', json.dumps({'source': 'claude-code', 'event': {'session_id': 's2', 'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'y'}}), self.auth)[0], 204)
        self.assertEqual(self.ingest({'hook_event_name': 'UserPromptSubmit', 'cwd': 'C:\\Work\\Other'}), 204)
        self.assertEqual(self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'z'}), 204)
        self.assertEqual(self.rows(), [('agent', 'Plan', 'p1', 1), ('skill', 'x', 'p1', 1), ('skill', 'y', '', 1), ('skill', 'z', 'p2', 1)])

    def test_unknown_folder_and_pathless_project_stay_unattributed(self):
        for cwd in ('D:\\Elsewhere', 'C:\\Work', ''):
            self.assertEqual(self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'x', 'cwd': cwd}), 204)
        self.assertEqual(self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'x'}), 204)
        self.assertEqual(self.rows(), [('skill', 'x', '', 4)])

    def test_a_resolver_failure_never_fails_the_hook(self):
        with mock.patch.object(self.store, 'project_for_cwd', side_effect=sqlite3.OperationalError('boom')):
            self.assertEqual(self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'x', 'cwd': PROJECT_ROOT}), 204)
        # The count survives; only the project attribution is lost.
        self.assertEqual(self.rows(), [('skill', 'x', '', 1)])
        self.assertEqual(len(self.server.live.snapshot()['sessions']), 1)


class ApiProjectTests(base.ServerCase):
    def setUp(self):
        super().setUp()
        register(self.store, ('p1', 'One', 'C:\\Work\\One'), ('p2', 'Two', 'C:\\Work\\Two'))

    def test_items_keep_aggregating_across_projects_and_project_items_split_them(self):
        s = self.store
        for project, times in (('p1', 3), ('p2', 1), ('', 2)):
            for _ in range(times):
                s.record_usage('claude-code', 'skill', 'x', day='2026-03-30', project=project)
        s.record_usage('codex', 'skill', 'x', day='2026-03-01', project='p1')
        s.record_usage('claude-code', 'agent', 'Explore', day='2026-03-29', project='p2')
        s.record_usage('history', 'agent', 'Explore', day='2026-01-01', project='p2')
        s.record_usage('claude-code', 'agent', 'Loose', day='2026-03-30')
        summary = s.usage_summary(today='2026-03-30')
        self.assertEqual({(row['kind'], row['name']): (row['total'], row['last7'], row['last30']) for row in summary['items']},
                         {('skill', 'x'): (7, 6, 7), ('agent', 'Explore'): (2, 1, 1), ('agent', 'Loose'): (1, 1, 1)})
        self.assertEqual(summary['projectItems'], [
            {'projectId': 'p1', 'kind': 'skill', 'name': 'x', 'total': 4, 'last7': 3, 'last30': 4, 'lastAt': '2026-03-30'},
            {'projectId': 'p2', 'kind': 'agent', 'name': 'Explore', 'total': 2, 'last7': 1, 'last30': 1, 'lastAt': '2026-03-29'},
            {'projectId': 'p2', 'kind': 'skill', 'name': 'x', 'total': 1, 'last7': 1, 'last30': 1, 'lastAt': '2026-03-30'}])
        # Per (kind, name): attributed rows plus the unattributed remainder add up to the total.
        for row in summary['items']:
            attributed = sum(item['total'] for item in summary['projectItems'] if (item['kind'], item['name']) == (row['kind'], row['name']))
            self.assertLessEqual(attributed, row['total'])
        self.assertEqual(sum(item['total'] for item in summary['projectItems']), 7)
        self.assertEqual(sum(row['total'] for row in summary['items']), 10)

    def test_project_items_are_capped_ordered_and_exclude_unattributed(self):
        with self.store.db:
            self.store.db.executemany("INSERT INTO usage (day, source, kind, name, project, count) VALUES ('2026-03-30', 'claude-code', 'skill', ?, 'p1', ?)", [('s' + str(n).zfill(5), 1 + n % 7) for n in range(5100)])
            self.store.db.execute("INSERT INTO usage (day, source, kind, name, project, count) VALUES ('2026-03-30', 'claude-code', 'skill', 'loose', '', 99)")
        summary = self.store.usage_summary(today='2026-03-30')
        items = summary['projectItems']
        self.assertEqual(len(items), 5000)
        self.assertEqual([item['total'] for item in items], sorted((item['total'] for item in items), reverse=True))
        self.assertNotIn('loose', {item['name'] for item in items})
        self.assertEqual(len(summary['items']), 5000)
        self.assertEqual(summary['items'][0]['name'], 'loose')

    def test_endpoint_shape_clear_and_no_folder_in_the_output(self):
        cookie, token = self.session()
        self.ingest({'hook_event_name': 'PreToolUse', 'tool_name': 'Skill', 'skill': 'x', 'cwd': 'C:\\Work\\One\\private-sub'})
        self.ingest({'hook_event_name': 'SubagentStart', 'agent_id': 'a', 'agent_type': 'Explore', 'cwd': 'C:\\Unregistered\\private-other'})
        status, usage = self.get_usage(cookie)
        today = base.datetime.now().date().isoformat()
        self.assertEqual(status, 200)
        self.assertEqual(set(usage), {'since', 'liveSince', 'skillTracking', 'history', 'items', 'projectItems'})
        self.assertEqual(usage['projectItems'], [{'projectId': 'p1', 'kind': 'skill', 'name': 'x', 'total': 1, 'last7': 1, 'last30': 1, 'lastAt': today}])
        self.assertEqual(len(usage['items']), 2)
        self.assertNotIn('private', json.dumps(usage))
        dump = json.dumps([self.store.db.execute('SELECT * FROM ' + table).fetchall() for table in ('usage', 'usage_meta')])
        self.assertNotIn('private', dump)
        self.assertNotIn('Unregistered', dump)
        self.assertEqual(self.post('/api/usage/clear', {}, cookie, token), (200, base.EMPTY))
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM usage').fetchone()[0], 0)
        self.assertEqual(self.store.project_for_cwd('C:\\Work\\One'), 'p1')


class ImportProjectTests(base.UsageCase):
    def setUp(self):
        super().setUp()
        self.projects = self.base / 'projects'
        self.projects.mkdir()
        register(self.store, ('p1', 'Proj', PROJECT_ROOT), ('p2', 'Other', 'C:\\Work\\Other'))
        self.stamp = base.local_ts('2026-03-10')

    def transcript(self, relative, lines):
        path = self.projects / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('\n'.join(lines) + '\n', encoding='utf-8')

    def run_import(self):
        return import_claude_history(self.store, projects_dir=self.projects, now=base.NOW)

    def project_counts(self):
        return {(row[0], row[1], row[2], row[3]): row[4] for row in self.store.db.execute("SELECT day, kind, name, project, count FROM usage WHERE source='history'")}

    def test_calls_are_attributed_by_the_line_folder(self):
        stamp, line, call = self.stamp, base.line, base.call
        self.transcript('any-folder-name/a.jsonl', [
            line([call('Skill', 'x', 't1'), call('Task', 'Explore', 't2')], stamp, cwd='c:/work/proj/web'),
            line([call('Skill', 'x', 't3')], stamp, cwd=PROJECT_ROOT),
            line([call('Skill', 'x', 't4')], stamp, cwd='C:\\Work\\Other\\sub'),
            line([call('Skill', 'x', 't5')], stamp, cwd='C:\\Work\\Proj-other'),
            line([call('Skill', 'x', 't6')], stamp, cwd=5),
            line([call('Skill', 'x', 't7')], stamp),
            line([call('Skill', 'x', 't8')], stamp, cwd='C:\\Work\\Proj\\' + 'd' * 1000),
        ])
        result = self.run_import()
        self.assertEqual(self.project_counts(), {
            ('2026-03-10', 'skill', 'x', 'p1'): 2, ('2026-03-10', 'agent', 'Explore', 'p1'): 1, ('2026-03-10', 'skill', 'x', 'p2'): 1, ('2026-03-10', 'skill', 'x', ''): 4})
        self.assertEqual((result['skill'], result['agent']), (7, 1))
        summary = self.store.usage_summary(today='2026-03-20')
        self.assertEqual({(row['kind'], row['name']): row['total'] for row in summary['items']}, {('skill', 'x'): 7, ('agent', 'Explore'): 1})
        self.assertEqual([(row['projectId'], row['kind'], row['name'], row['total']) for row in summary['projectItems']], [('p1', 'skill', 'x', 2), ('p1', 'agent', 'Explore', 1), ('p2', 'skill', 'x', 1)])

    def test_reimport_is_idempotent_and_follows_organization_changes(self):
        self.transcript('p/a.jsonl', [base.line([base.call('Skill', 'x', 't1')], self.stamp, cwd=PROJECT_ROOT + '\\a')])
        first = self.run_import()
        rows = self.project_counts()
        self.assertEqual(self.run_import(), first)
        self.assertEqual(self.project_counts(), rows)
        self.assertEqual(rows, {('2026-03-10', 'skill', 'x', 'p1'): 1})
        register(self.store, ('p9', 'Moved', PROJECT_ROOT))
        self.run_import()
        self.assertEqual(self.project_counts(), {('2026-03-10', 'skill', 'x', 'p9'): 1})
        register(self.store)
        self.run_import()
        self.assertEqual(self.project_counts(), {('2026-03-10', 'skill', 'x', ''): 1})

    def test_history_cut_and_live_rows_still_apply_per_project(self):
        lines = [base.line([base.call('Skill', 'x', 't' + str(day))], base.local_ts('2026-03-' + str(day)), cwd=PROJECT_ROOT) for day in (10, 11, 12)]
        self.transcript('p/a.jsonl', lines)
        self.store.record_usage('claude-code', 'skill', 'x', day='2026-03-12', project='p1')
        self.run_import()
        # 03-12 was counted live (same call, same project): history adds nothing for that day.
        self.assertEqual(self.project_counts(), {('2026-03-10', 'skill', 'x', 'p1'): 1, ('2026-03-11', 'skill', 'x', 'p1'): 1})
        self.assertEqual(self.store.usage_summary(today='2026-03-20')['projectItems'][0]['total'], 3)

    def test_the_folder_never_reaches_the_database_or_the_output(self):
        self.transcript('p/a.jsonl', [
            base.line([base.call('Skill', 'x', 't1')], self.stamp, cwd=PROJECT_ROOT + '\\inner-secret-sub'),
            base.line([base.call('Skill', 'x', 't2')], self.stamp, cwd='D:\\outside-secret-folder'),
        ])
        result = self.run_import()
        self.store.db.commit()
        dump = json.dumps([result, self.store.usage_summary(today='2026-03-20'), [self.store.db.execute('SELECT * FROM ' + table).fetchall() for table in ('usage', 'usage_meta', 'history')]])
        raw = (self.base / 'data' / 'agent-city.sqlite3').read_bytes()
        for secret in ('inner-secret-sub', 'outside-secret-folder'):
            self.assertNotIn(secret, dump)
            self.assertNotIn(secret.encode(), raw)

    def test_clear_removes_project_rows(self):
        self.transcript('p/a.jsonl', [base.line([base.call('Skill', 'x', 't1')], self.stamp, cwd=PROJECT_ROOT)])
        self.run_import()
        self.store.record_usage('claude-code', 'skill', 'y', day='2026-03-30', project='p2')
        self.assertEqual(len(self.store.usage_summary(today='2026-03-30')['projectItems']), 2)
        self.store.clear_usage()
        self.assertEqual(self.store.usage_summary(today='2026-03-30'), base.EMPTY)


if __name__ == '__main__':
    unittest.main()
