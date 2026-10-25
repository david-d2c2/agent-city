import http.client
import http.server
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

from agent_city import __main__ as entry
from agent_city.live import registry_file, write_registry
from agent_city.server import make_server
from agent_city.store import Store


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        patcher = mock.patch.dict(os.environ, {'AGENT_CITY_HOME': self.home.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def start_city(self, publish=True):
        data = tempfile.TemporaryDirectory()
        self.addCleanup(data.cleanup)
        store = Store(data.name)
        server = make_server(store, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def close():
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
            store.close()
        self.addCleanup(close)
        port = server.server_address[1]
        if publish:
            write_registry(port, server.ingest_token)
        return server, thread, port

    def impostor(self):
        other = http.server.ThreadingHTTPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (other.shutdown(), other.server_close()))
        return other.server_address[1]

    def test_city_running_needs_the_registered_token(self):
        _, _, port = self.start_city()
        self.assertTrue(entry.city_running(port))
        self.assertFalse(entry.city_running(port + 1))  # registry names another port

    def test_city_running_rejects_a_lookalike_even_with_the_registry_pointing_at_it(self):
        port = self.impostor()
        write_registry(port, 'whatever-token')
        self.assertFalse(entry.city_running(port))

    def test_city_running_rejects_a_city_whose_token_is_not_the_published_one(self):
        server, _, port = self.start_city(publish=False)
        write_registry(port, 'not-the-token-of-this-city')
        self.assertFalse(entry.city_running(port))

    def test_city_running_is_false_without_a_registry_or_a_listener(self):
        self.assertFalse(entry.city_running(65000))
        self.assertIsNone(entry.registry_info())

    def test_stop_asks_the_city_to_exit_without_killing_any_process(self):
        server, thread, port = self.start_city()
        with mock.patch.object(os, 'kill', side_effect=AssertionError('stop must not kill by pid')):
            self.assertEqual(entry.stop_city(), 'Agent City se ha detenido.')
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())

    def test_stop_ignores_a_stale_or_forged_registry(self):
        self.assertEqual(entry.stop_city(), 'Agent City no está en marcha.')
        port = self.impostor()
        write_registry(port, 'forged')
        self.assertEqual(entry.stop_city(), 'Agent City no está en marcha.')
        server, thread, real = self.start_city(publish=False)
        write_registry(real, 'wrong-token')
        self.assertEqual(entry.stop_city(), 'Agent City no está en marcha.')
        self.assertTrue(thread.is_alive())

    def test_stop_rejects_malformed_registry(self):
        target = registry_file()
        target.parent.mkdir(parents=True, exist_ok=True)
        for content in ('not json', '{}', json.dumps({'port': '1', 'token': 't'}), json.dumps({'port': 4317, 'token': ''}), json.dumps({'port': True, 'token': 't'})):
            target.write_text(content, encoding='utf-8')
            self.assertEqual(entry.stop_city(), 'Agent City no está en marcha.')

    def test_control_endpoints_need_the_bearer_token_and_no_origin(self):
        server, thread, port = self.start_city()
        token = server.ingest_token

        def call(method, path, headers):
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
            conn.request(method, path, headers=headers)
            status = conn.getresponse().status
            conn.close()
            return status

        self.assertEqual(call('GET', '/api/ping', {}), 401)
        self.assertEqual(call('GET', '/api/ping', {'Authorization': 'Bearer nope'}), 401)
        self.assertEqual(call('POST', '/api/shutdown', {'Authorization': 'Bearer nope'}), 401)
        self.assertEqual(call('GET', '/api/ping', {'Authorization': 'Bearer ' + token, 'Origin': 'http://evil.example'}), 403)
        self.assertEqual(call('POST', '/api/shutdown', {'Authorization': 'Bearer ' + token, 'Origin': 'http://127.0.0.1:%d' % port}), 403)
        self.assertTrue(thread.is_alive())
        self.assertEqual(call('GET', '/api/ping', {'Authorization': 'Bearer ' + token}), 204)

    def test_second_start_reuses_the_running_city(self):
        _, _, port = self.start_city()
        data = tempfile.TemporaryDirectory()
        self.addCleanup(data.cleanup)
        with mock.patch.object(sys, 'argv', ['agent_city', '--port', str(port), '--data-dir', data.name, '--open']), \
                mock.patch.object(entry.webbrowser, 'open') as opened, \
                mock.patch.object(entry, 'make_server', side_effect=AssertionError('second server')):
            entry.main()
        opened.assert_called_once_with('http://127.0.0.1:' + str(port))
        self.assertFalse(Path(data.name, 'agent-city.sqlite3').exists())

    def test_start_does_not_reuse_or_open_a_lookalike_on_the_port(self):
        port = self.impostor()
        data = tempfile.TemporaryDirectory()
        self.addCleanup(data.cleanup)
        with mock.patch.object(sys, 'argv', ['agent_city', '--port', str(port), '--data-dir', data.name, '--open']), \
                mock.patch.object(entry.webbrowser, 'open') as opened:
            with self.assertRaises(SystemExit) as caught:
                entry.main()
        self.assertEqual(caught.exception.code, 1)
        opened.assert_not_called()


if __name__ == '__main__':
    unittest.main()
