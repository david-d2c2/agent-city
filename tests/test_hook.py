import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / 'hooks' / 'agent_city_hook.py'
spec = importlib.util.spec_from_file_location('agent_city_hook', SCRIPT)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)

TOKEN = 'secret-token'
CLAUDE_PAYLOAD = {
    'hook_event_name': 'PreToolUse', 'session_id': 's1', 'cwd': 'C:/proj',
    'tool_name': 'Bash', 'agent_id': 'a1', 'agent_type': 'reviewer',
    'prompt': 'SECRET PROMPT', 'tool_input': {'command': 'rm -rf'},
    'transcript_path': '/t.jsonl', 'permission_mode': 'default',
}
CODEX_PAYLOAD = {'hook_event_name': 'Stop', 'session_id': 'c1', 'cwd': '/w', 'prompt': 'x'}


class FakeServer:
    """Records requests; status is configurable; mode 'hang' never answers."""

    def __init__(self, status=204):
        outer = self
        self.requests = []
        self.status = status

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get('Content-Length', 0))
                outer.requests.append({
                    'method': self.command, 'path': self.path,
                    'headers': dict(self.headers), 'body': self.rfile.read(length),
                })
                self.send_response(outer.status)
                self.send_header('Content-Length', '0')
                self.end_headers()

            def log_message(self, *args):
                pass

        self.httpd = HTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class HookCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        self.env = {'AGENT_CITY_HOME': self.home}

    def write_registry(self, **over):
        reg = {'protocol': 1, 'port': 4321, 'pid': 1, 'token': TOKEN, 'startedAt': 0}
        reg.update(over)
        Path(self.home, 'server.json').write_text(json.dumps(reg), encoding='utf-8')

    def start_server(self, status=204):
        server = FakeServer(status)
        self.addCleanup(server.close)
        self.write_registry(port=server.port)
        return server

    def run_script(self, args, stdin=b'{}', timeout=10):
        env = dict(os.environ, AGENT_CITY_HOME=self.home)
        started = time.monotonic()
        proc = subprocess.run([sys.executable, str(SCRIPT), *args], input=stdin,
                              capture_output=True, env=env, timeout=timeout)
        return proc, time.monotonic() - started

    def assert_silent_ok(self, proc):
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, b'')
        self.assertEqual(proc.stderr, b'')


class BuildEventTest(unittest.TestCase):
    def test_drops_sensitive_unknown_and_non_string(self):
        event = hook.build_event(dict(CLAUDE_PAYLOAD, session_id=5, extra='x'))
        self.assertEqual(event, {
            'hook_event_name': 'PreToolUse', 'cwd': 'C:/proj', 'tool_name': 'Bash',
            'agent_id': 'a1', 'agent_type': 'reviewer',
        })

    def test_non_object_gives_empty(self):
        for value in ([], 'x', None, 3):
            self.assertEqual(hook.build_event(value), {})


class RegistryTest(HookCase):
    def test_valid(self):
        self.write_registry()
        self.assertEqual(hook.find_registry(self.env), (4321, TOKEN))

    def test_invalid_variants(self):
        self.assertIsNone(hook.find_registry(self.env))  # missing file
        Path(self.home, 'server.json').write_text('{not json', encoding='utf-8')
        self.assertIsNone(hook.find_registry(self.env))
        for over in ({'protocol': 2}, {'port': 0}, {'port': 70000}, {'port': '80'},
                     {'port': True}, {'token': ''}, {'token': 5}):
            self.write_registry(**over)
            self.assertIsNone(hook.find_registry(self.env), over)

    def test_invalid_registry_sends_no_request(self):
        server = FakeServer()
        self.addCleanup(server.close)
        self.write_registry(port=server.port, token='')
        self.assertEqual(hook.main(['--source', 'codex'], json.dumps(CODEX_PAYLOAD).encode(), self.env), 0)
        self.assertEqual(server.requests, [])


class PostTest(HookCase):
    def test_claude_code_request_shape(self):
        server = self.start_server()
        raw = json.dumps(CLAUDE_PAYLOAD).encode()
        self.assertEqual(hook.main(['--source', 'claude-code'], raw, self.env), 0)
        req = server.requests[0]
        self.assertEqual((req['method'], req['path']), ('POST', '/api/ingest'))
        self.assertEqual(req['headers']['Authorization'], 'Bearer ' + TOKEN)
        self.assertEqual(req['headers']['Content-Type'], 'application/json')
        self.assertEqual(req['headers']['Host'], '127.0.0.1:%d' % server.port)
        body = json.loads(req['body'])
        self.assertEqual(body, {'source': 'claude-code', 'event': {
            'hook_event_name': 'PreToolUse', 'session_id': 's1', 'cwd': 'C:/proj',
            'tool_name': 'Bash', 'agent_id': 'a1', 'agent_type': 'reviewer'}})
        for leaked in (b'SECRET PROMPT', b'rm -rf', b'prompt', b'tool_input', b'transcript'):
            self.assertNotIn(leaked, req['body'])

    def test_codex_request_shape(self):
        server = self.start_server()
        hook.main(['--source', 'codex'], json.dumps(CODEX_PAYLOAD).encode(), self.env)
        body = json.loads(server.requests[0]['body'])
        self.assertEqual(body, {'source': 'codex', 'event': {
            'hook_event_name': 'Stop', 'session_id': 'c1', 'cwd': '/w'}})
        self.assertNotIn(b'prompt', server.requests[0]['body'])


class SubprocessTest(HookCase):
    def test_no_registry(self):
        proc, _ = self.run_script(['--source', 'codex'], json.dumps(CODEX_PAYLOAD).encode())
        self.assert_silent_ok(proc)

    def test_closed_port(self):
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        sock.close()
        self.write_registry(port=port)
        proc, _ = self.run_script(['--source', 'claude-code'], json.dumps(CLAUDE_PAYLOAD).encode())
        self.assert_silent_ok(proc)

    def test_garbage_and_empty_stdin(self):
        server = self.start_server()
        for raw in (b'\xff\xfe not json', b'', b'[1,2]', b'"str"'):
            proc, _ = self.run_script(['--source', 'claude-code'], raw)
            self.assert_silent_ok(proc)
        self.assertEqual(server.requests, [])

    def test_invalid_source(self):
        server = self.start_server()
        for args in (['--source', 'other'], [], ['--source']):
            proc, _ = self.run_script(args, json.dumps(CLAUDE_PAYLOAD).encode())
            self.assert_silent_ok(proc)
        self.assertEqual(server.requests, [])

    def test_success_delivers(self):
        server = self.start_server()
        proc, _ = self.run_script(['--source', 'claude-code'], json.dumps(CLAUDE_PAYLOAD).encode())
        self.assert_silent_ok(proc)
        self.assertEqual(len(server.requests), 1)

    def test_unauthorized_response(self):
        server = self.start_server(status=401)
        proc, _ = self.run_script(['--source', 'claude-code'], json.dumps(CLAUDE_PAYLOAD).encode())
        self.assert_silent_ok(proc)
        self.assertEqual(len(server.requests), 1)

    def test_server_that_never_answers(self):
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(5)  # accepts into the backlog, never reads or replies
        self.addCleanup(listener.close)
        self.write_registry(port=listener.getsockname()[1])
        proc, elapsed = self.run_script(['--source', 'claude-code'], json.dumps(CLAUDE_PAYLOAD).encode())
        self.assert_silent_ok(proc)
        self.assertLess(elapsed, 2.0)


if __name__ == '__main__':
    unittest.main()
