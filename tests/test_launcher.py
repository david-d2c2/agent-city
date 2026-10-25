import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

from agent_city import __main__ as entry
from agent_city.live import registry_file
from agent_city.server import make_server
from agent_city.store import Store


def sleeper():
    return subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        patcher = mock.patch.dict(os.environ, {'AGENT_CITY_HOME': self.home.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def start_city(self):
        data = tempfile.TemporaryDirectory()
        self.addCleanup(data.cleanup)
        store = Store(data.name)
        server = make_server(store, 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()

        def close():
            server.shutdown()
            server.server_close()
            store.close()
        self.addCleanup(close)
        return server.server_address[1]

    def write_registry(self, port, pid):
        target = registry_file()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({'protocol': 1, 'port': port, 'pid': pid, 'token': 't', 'startedAt': 0}), encoding='utf-8')

    def test_city_running_detects_only_agent_city(self):
        port = self.start_city()
        self.assertTrue(entry.city_running(port))

        other = http.server.ThreadingHTTPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (other.shutdown(), other.server_close()))
        self.assertFalse(entry.city_running(other.server_address[1]))

        free = http.server.ThreadingHTTPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler)
        closed_port = free.server_address[1]
        free.server_close()
        self.assertFalse(entry.city_running(closed_port))

    def test_stop_ends_the_registered_city_process(self):
        port = self.start_city()
        child = sleeper()
        self.addCleanup(child.kill)
        self.write_registry(port, child.pid)
        self.assertEqual(entry.stop_city(), 'Agent City se ha detenido.')
        child.wait(timeout=10)
        self.assertFalse(registry_file().exists())

    def test_stop_never_kills_a_process_when_the_port_is_not_agent_city(self):
        other = http.server.ThreadingHTTPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (other.shutdown(), other.server_close()))
        child = sleeper()
        self.addCleanup(child.kill)
        self.write_registry(other.server_address[1], child.pid)
        self.assertEqual(entry.stop_city(), 'Agent City no está en marcha.')
        self.assertIsNone(child.poll())

    def test_stop_rejects_missing_or_malformed_registry(self):
        self.assertEqual(entry.stop_city(), 'Agent City no está en marcha.')
        target = registry_file()
        target.parent.mkdir(parents=True, exist_ok=True)
        for content in ('not json', '{}', json.dumps({'port': '1', 'pid': 2}), json.dumps({'port': 4317, 'pid': True})):
            target.write_text(content, encoding='utf-8')
            self.assertEqual(entry.stop_city(), 'Agent City no está en marcha.')

    def test_second_start_reuses_the_running_city(self):
        port = self.start_city()
        data = tempfile.TemporaryDirectory()
        self.addCleanup(data.cleanup)
        with mock.patch.object(sys, 'argv', ['agent_city', '--port', str(port), '--data-dir', data.name, '--open']), \
                mock.patch.object(entry.webbrowser, 'open') as opened, \
                mock.patch.object(entry, 'make_server', side_effect=AssertionError('second server')):
            entry.main()
        opened.assert_called_once_with('http://127.0.0.1:' + str(port))
        self.assertFalse(Path(data.name, 'agent-city.sqlite3').exists())


if __name__ == '__main__':
    unittest.main()
