import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

try:
    from agent_city import live
    from agent_city.live import LiveState, normalize_event
    from agent_city.server import make_server
    from agent_city.store import Store
except ImportError:
    live = None


def ev(name, session='s1', **extra):
    return {'hook_event_name': name, 'session_id': session, **extra}


def set_home(case, value):
    previous = os.environ.get('AGENT_CITY_HOME')
    os.environ['AGENT_CITY_HOME'] = value
    case.addCleanup(lambda: os.environ.pop('AGENT_CITY_HOME', None) if previous is None else os.environ.__setitem__('AGENT_CITY_HOME', previous))


class StateTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(live, 'Live module is not implemented')
        self.t = [1000.0]
        self.state = LiveState(clock=lambda: self.t[0])

    def send(self, name, source='claude-code', **extra):
        self.state.apply(source, ev(name, **extra))

    def one(self, index=0):
        return self.state.snapshot()['sessions'][index]

    def test_main_session_transitions(self):
        self.assertEqual(self.state.snapshot(), {'connected': False, 'lastEventAt': None, 'sessions': []})
        self.send('SessionStart', cwd='C:/p')
        self.assertEqual((self.one()['state'], self.one()['active'], self.one()['cwd']), ('idle', False, 'C:/p'))
        self.send('UserPromptSubmit')
        self.assertEqual((self.one()['state'], self.one()['tool'], self.one()['active']), ('working', None, True))
        self.send('PreToolUse', tool_name='Bash')
        self.assertEqual((self.one()['tool'], self.one()['active']), ('Bash', True))
        self.send('PostToolUse')
        self.assertEqual((self.one()['state'], self.one()['tool']), ('working', None))
        self.send('Notification')
        self.assertEqual(self.one()['state'], 'waiting')
        self.send('PermissionRequest')
        self.assertEqual(self.one()['state'], 'waiting')
        self.send('Stop')
        self.assertEqual((self.one()['state'], self.one()['active']), ('idle', False))
        self.assertTrue(self.state.snapshot()['connected'])
        self.send('SessionEnd')
        self.assertEqual(self.state.snapshot()['sessions'], [])

    def test_unknown_session_is_created_and_sources_are_separate(self):
        self.send('PreToolUse', tool_name='Read')
        self.send('PreToolUse', source='codex', tool_name='Edit')
        self.assertEqual(sorted(s['source'] for s in self.state.snapshot()['sessions']), ['claude-code', 'codex'])

    def test_subagents(self):
        self.send('UserPromptSubmit')
        self.send('SubagentStart', agent_id='a1', agent_type='Explore')
        self.send('PreToolUse', tool_name='Grep', agent_id='a1', agent_type='Explore')
        sessions = self.state.snapshot()['sessions']
        self.assertEqual(len(sessions), 2)
        sub = next(s for s in sessions if s['parentKey'])
        self.assertEqual((sub['agentType'], sub['tool'], sub['parentKey'], sub['active']), ('Explore', 'Grep', 'claude-code|s1', True))
        self.send('SubagentStop', agent_id='a1')
        self.assertEqual(len(self.state.snapshot()['sessions']), 1)
        self.send('PreToolUse', tool_name='Read', agent_id='a2', agent_type='Plan')
        self.assertEqual(len(self.state.snapshot()['sessions']), 2)
        self.send('Stop')
        self.assertEqual([s['parentKey'] for s in self.state.snapshot()['sessions']], [None])
        self.send('SubagentStart', agent_id='a3', agent_type='X')
        self.send('SessionEnd')
        self.assertEqual(self.state.snapshot()['sessions'], [])

    def test_unknown_event_is_ignored(self):
        self.send('SomethingNew')
        snap = self.state.snapshot()
        self.assertEqual((snap['sessions'], snap['connected']), ([], True))

    def test_ttl_expiry(self):
        self.send('UserPromptSubmit')
        self.t[0] += 59
        self.assertTrue(self.one()['active'])
        self.assertEqual(self.one()['ageSeconds'], 59)
        self.t[0] += 2
        self.assertFalse(self.one()['active'])
        self.assertEqual(self.one()['state'], 'working')
        self.send('PreToolUse', tool_name='Bash')
        self.t[0] += 299
        self.assertTrue(self.one()['active'])
        self.t[0] += 2
        self.assertFalse(self.one()['active'])
        self.send('Notification')
        self.t[0] += 299
        self.assertTrue(self.one()['active'])
        self.t[0] += 2
        self.assertFalse(self.one()['active'])
        self.t[0] += 300
        self.assertEqual(self.state.snapshot()['sessions'], [])

    def test_cap_of_two_hundred_drops_oldest(self):
        for n in range(205):
            self.t[0] += 1
            self.state.apply('codex', ev('PreToolUse', session='s' + str(n)))
        ids = {s['sessionId'] for s in self.state.snapshot()['sessions']}
        self.assertEqual(len(ids), 200)
        self.assertNotIn('s0', ids)
        self.assertIn('s204', ids)

    def test_normalize_allowlist_and_validation(self):
        clean = normalize_event('codex', {**ev('PreToolUse', tool_name='Bash'), 'prompt': 'SECRET', 'tool_input': {'command': 'SECRET'}, 'transcript_path': 'x'})
        self.assertEqual(clean, {'hook_event_name': 'PreToolUse', 'session_id': 's1', 'tool_name': 'Bash'})
        self.state.apply('codex', clean)
        self.assertNotIn('SECRET', json.dumps(self.state.snapshot()))
        for bad in [{}, ev(''), {'hook_event_name': 'Stop'}, ev('Stop', tool_name=5), ev('Stop', tool_name='x' * 301), ev('Stop', cwd='x' * 1001), 'text']:
            with self.assertRaises(ValueError):
                normalize_event('codex', bad)
        with self.assertRaises(ValueError):
            normalize_event('other', ev('Stop'))
        self.assertEqual(normalize_event('codex', ev('Stop', cwd='x' * 1000))['cwd'], 'x' * 1000)


    def test_normalize_skill_validation_and_scope(self):
        skill = ev('PreToolUse', tool_name='Skill', skill='plug:frontend-design')
        self.assertEqual(normalize_event('claude-code', {**skill, 'tool_input': {'skill': 'other', 'args': 'SECRET'}}), {'hook_event_name': 'PreToolUse', 'session_id': 's1', 'tool_name': 'Skill', 'skill': 'plug:frontend-design'})
        self.assertEqual(live.usage_of(normalize_event('codex', skill)), ('skill', 'plug:frontend-design'))
        # Valid names are dropped unless the event is PreToolUse of the Skill tool.
        for other in (ev('PostToolUse', tool_name='Skill', skill='x'), ev('PreToolUse', tool_name='Bash', skill='x'), ev('PreToolUse', skill='x'), ev('Stop', tool_name='Skill', skill='x')):
            clean = normalize_event('codex', other)
            self.assertNotIn('skill', clean)
            self.assertIsNone(live.usage_of(clean))
        for bad in ('', 'a b', 'a\nb', 'x' * 121, 5, None, ['x'], {'a': 1}):
            with self.assertRaises(ValueError):
                normalize_event('codex', {**skill, 'skill': bad})
            with self.assertRaises(ValueError):
                normalize_event('codex', ev('Stop', skill=bad))
        self.state.apply('codex', normalize_event('codex', skill))
        self.assertNotIn('frontend-design', json.dumps(self.state.snapshot()))

    def test_usage_of_agents(self):
        self.assertEqual(live.usage_of(normalize_event('claude-code', ev('SubagentStart', agent_id='a1', agent_type='Explore'))), ('agent', 'Explore'))
        for other in (ev('SubagentStart', agent_id='a1'), ev('SubagentStop', agent_id='a1', agent_type='Explore'), ev('PreToolUse', tool_name='Grep', agent_id='a1', agent_type='Explore'), ev('PostToolUse', tool_name='Skill', agent_type='Explore')):
            self.assertIsNone(live.usage_of(normalize_event('claude-code', other)))


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(live, 'Live module is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        set_home(self, self.temp.name)

    def test_write_and_conditional_remove(self):
        path = live.write_registry(4317, 'tok')
        self.assertEqual(path, Path(self.temp.name) / 'server.json')
        data = json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual((data['protocol'], data['port'], data['pid'], data['token']), (1, 4317, os.getpid(), 'tok'))
        self.assertIsInstance(data['startedAt'], int)
        self.assertEqual([p.name for p in Path(self.temp.name).iterdir()], ['server.json'])
        live.remove_registry('other')
        self.assertTrue(path.exists())
        live.write_registry(4318, 'newer')
        live.remove_registry('tok')
        self.assertTrue(path.exists())
        live.remove_registry('newer')
        self.assertFalse(path.exists())
        live.remove_registry('newer')

    def test_connect_info(self):
        info = live.connect_info('C:\\x\\hooks\\agent_city_hook.py', 'C:\\Py\\python.exe', 'R')
        claude = json.loads(info['claudeCode']['snippet'])['hooks']
        self.assertEqual(list(claude), list(live.CLAUDE_EVENTS))
        group = claude['Stop'][0]
        self.assertEqual(group['matcher'], '')
        self.assertEqual(group['hooks'][0]['timeout'], 2)
        self.assertEqual(group['hooks'][0]['command'], '[ ! -f "C:/x/hooks/agent_city_hook.py" ] || "C:/Py/python.exe" "C:/x/hooks/agent_city_hook.py" --source claude-code || true')
        self.assertEqual(list(json.loads(info['codex']['snippet'])['hooks']), ['PreToolUse', 'PostToolUse', 'Stop'])
        self.assertIn('--source codex', info['codex']['snippet'])
        self.assertEqual((info['registry'], info['codex']['file']), ('R', '~/.codex/hooks.json'))


class IngestTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(live, 'Live module is not implemented')
        temp_root = Path(__file__).resolve().parent.parent / '.local' / 'tests'
        temp_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        (base / 'web').mkdir()
        (base / 'web' / 'index.html').write_text('<!doctype html>City', encoding='utf-8')
        self.store = Store(base / 'data')
        self.addCleanup(self.store.close)
        self.server = make_server(self.store, port=0, web_dir=base / 'web')
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]
        self.auth = {'Authorization': 'Bearer ' + self.server.ingest_token, 'Content-Type': 'application/json'}

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port)
        self.addCleanup(conn.close)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, dict(response.getheaders()), response.read()

    def post(self, payload, headers=None):
        body = payload if isinstance(payload, (str, bytes)) else json.dumps(payload)
        return self.request('POST', '/api/ingest', body, self.auth if headers is None else headers)[0]

    def good(self):
        return {'source': 'claude-code', 'event': {'hook_event_name': 'PreToolUse', 'session_id': 's1', 'tool_name': 'Bash', 'cwd': 'C:/p', 'tool_input': {'command': 'SECRET'}}}

    def test_ingest_accepts_without_session_cookie(self):
        self.assertEqual(self.post(self.good()), 204)
        self.assertEqual(self.server.live.snapshot()['sessions'][0]['tool'], 'Bash')
        self.assertNotIn('SECRET', json.dumps(self.server.live.snapshot()))

    def test_ingest_authentication_and_origin(self):
        no_token = {'Content-Type': 'application/json'}
        wrong = {**self.auth, 'Authorization': 'Bearer nope'}
        for headers in (no_token, wrong, {**self.auth, 'Authorization': self.server.ingest_token}):
            status, _, data = self.request('POST', '/api/ingest', json.dumps(self.good()), headers)
            self.assertEqual(status, 401)
            self.assertNotIn(self.server.ingest_token, data.decode())
        self.assertEqual(self.post(self.good(), {**self.auth, 'Origin': 'http://127.0.0.1:' + str(self.port)}), 403)
        self.assertEqual(self.post(self.good(), {**self.auth, 'Origin': 'null'}), 403)
        self.assertEqual(self.request('POST', '/api/ingest', json.dumps(self.good()), {**self.auth, 'Host': 'evil.example'})[0], 403)
        self.assertEqual(self.server.live.snapshot()['sessions'], [])

    def test_ingest_size_and_body_validation(self):
        self.assertEqual(self.post(' ' * 16385), 413)
        self.assertEqual(self.post('['), 400)
        self.assertEqual(self.post('[]'), 400)
        self.assertEqual(self.post({'source': 'nope', 'event': self.good()['event']}), 400)
        self.assertEqual(self.post({'source': 'codex', 'event': {'hook_event_name': 'Stop'}}), 400)
        self.assertEqual(self.post({'source': 'codex', 'event': {'hook_event_name': 'Stop', 'session_id': 5}}), 400)
        self.assertEqual(self.post({'source': 'codex'}), 400)
        self.assertEqual(self.post(self.good(), {'Authorization': self.auth['Authorization'], 'Content-Type': 'text/plain'}), 400)
        self.assertEqual(self.post({'source': 'codex', 'event': {'hook_event_name': 'Mystery', 'session_id': 'z'}}), 204)
        self.assertEqual(self.server.live.snapshot()['sessions'], [])

    def test_live_requires_session_and_returns_snapshot_with_connect(self):
        self.assertEqual(self.request('GET', '/api/live')[0], 403)
        self.assertEqual(self.request('GET', '/api/live', headers=self.auth)[0], 403)
        self.assertEqual(self.post(self.good()), 204)
        _, headers, _ = self.request('GET', '/')
        session = {'Cookie': headers['Set-Cookie'].split(';')[0], 'Sec-Fetch-Site': 'same-origin'}
        status, _, data = self.request('GET', '/api/live', headers=session)
        self.assertEqual(status, 200)
        body = json.loads(data)
        self.assertTrue(body['connected'])
        self.assertEqual(body['sessions'][0]['key'], 'claude-code|s1')
        self.assertEqual(body['sessions'][0]['ageSeconds'], 0)
        self.assertTrue(body['connect']['hookScript'].endswith('agent_city_hook.py'))
        self.assertIn('hooks', json.loads(body['connect']['claudeCode']['snippet']))
        self.assertNotIn(self.server.ingest_token, data.decode())

    def test_make_server_does_not_write_registry(self):
        with tempfile.TemporaryDirectory() as home:
            set_home(self, home)
            make_server(self.store, port=0).server_close()
            self.assertEqual(os.listdir(home), [])


if __name__ == '__main__':
    unittest.main()
