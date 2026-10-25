"""Regression tests for the issues found by the independent security review."""
import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from agent_city import catalog
from agent_city.server import make_server
from agent_city.store import Store, usage_name


class TempCase(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        # Resolved like approved_path does: CI runners hand out 8.3 short names (RUNNER~1) that resolve() expands.
        self.base = Path(folder.name).resolve()


class CatalogHardeningTests(TempCase):
    def skill(self, header):
        folder = self.base / 'skill'
        folder.mkdir(exist_ok=True)
        path = folder / 'SKILL.md'
        path.write_text('---\nname: demo\n' + header + '---\nbody\n', encoding='utf-8')
        return path

    def test_block_tool_list_is_still_parsed(self):
        path = self.skill('allowed-tools:\n  - Read\n  - Bash\n')
        _, _, details = catalog.read_metadata(path, self.base, 'skills')
        self.assertEqual(details['allowedTools'], ['Read', 'Bash'])

    def test_malformed_block_rows_are_rejected_without_touching_other_fields(self):
        for rows in ('  Read\n', '  -Read\n', '\t-\n', '  - ok\n  junk\n'):
            path = self.skill('license: MIT\nallowed-tools:\n' + rows)
            _, _, details = catalog.read_metadata(path, self.base, 'skills')
            self.assertIsNone(details['allowedTools'], rows)
            self.assertEqual(details['license'], 'MIT')

    def test_a_hostile_long_tool_line_costs_nothing(self):
        path = self.skill('allowed-tools:\n  - x' + ' ' * 60000 + 'y\n')
        started = time.perf_counter()
        _, _, details = catalog.read_metadata(path, self.base, 'skills')
        self.assertLess(time.perf_counter() - started, 1.0)
        self.assertIsNone(details['allowedTools'])

    def test_a_deeply_nested_toml_is_one_invalid_definition_not_a_crash(self):
        source = self.base / 'roles'
        source.mkdir()
        (source / 'evil.toml').write_text('z = ' + '[' * 20000 + ']' * 20000 + '\nname = "x"\n', encoding='utf-8')
        (source / 'good.toml').write_text('name = "Good"\ndescription = "ok"\n', encoding='utf-8')
        result = catalog.scan({'id': 'r', 'path': str(source), 'format': 'roles'})
        by_name = {item['source']['relativePath']: item['validity'] for item in result['items']}
        self.assertEqual(by_name, {'evil.toml': 'invalid', 'good.toml': 'valid'})

    @unittest.skipUnless(sys.platform == 'win32', 'UNC paths are a Windows concept')
    def test_network_and_device_paths_are_rejected(self):
        for value in ('\\\\attacker-host\\share', '//attacker-host/share', '\\\\?\\C:\\Windows', '\\\\.\\pipe\\x'):
            with self.assertRaises(ValueError, msg=value):
                catalog.approved_path(value)

    def test_bidi_and_zero_width_controls_are_stripped_from_names(self):
        self.assertEqual(catalog.clean_string('abc\u202edef\u200b'), 'abcdef')
        self.assertEqual(catalog.clean_string('\u2066x\u2069y', required=True), 'xy')
        self.assertIsNone(usage_name('good\u202ename'))
        self.assertEqual(usage_name('plain-name'), 'plain-name')


class BulkIsolationTests(TempCase):
    def test_one_hostile_source_never_aborts_the_others(self):
        evil, good = self.base / 'evil', self.base / 'good'
        evil.mkdir()
        good.mkdir()
        (evil / 'evil.toml').write_text('z = ' + '[' * 20000 + ']' * 20000 + '\n', encoding='utf-8')
        (good / 'good.toml').write_text('name = "Good"\ndescription = "ok"\n', encoding='utf-8')
        store = Store(str(self.base / 'data'))
        self.addCleanup(store.close)
        state = store.approve_roots([
            {'path': str(evil), 'label': 'Evil', 'format': 'roles'},
            {'path': str(good), 'label': 'Good', 'format': 'roles'},
        ])
        self.assertEqual([r['status'] for r in state['results']], ['ok', 'ok'])
        self.assertEqual([r['imported'] for r in state['results']], [0, 1])
        self.assertEqual(sorted(item['name'] for item in state['catalog'] if item['validity'] == 'valid'), ['Good'])

    def test_an_unexpected_error_in_one_root_is_reported_and_the_rest_continue(self):
        good = self.base / 'good'
        good.mkdir()
        (good / 'good.toml').write_text('name = "Good"\n', encoding='utf-8')
        store = Store(str(self.base / 'data'))
        self.addCleanup(store.close)
        real = store._checked_root
        calls = []

        def flaky(path, label, format):
            calls.append(label)
            if label == 'Boom':
                raise RecursionError('hostile')
            return real(path, label, format)

        with mock.patch.object(store, '_checked_root', side_effect=flaky):
            state = store.approve_roots([
                {'path': str(good), 'label': 'Boom', 'format': 'roles'},
                {'path': str(good), 'label': 'Good', 'format': 'roles'},
            ])
        self.assertEqual([r['status'] for r in state['results']], ['failed', 'ok'])
        self.assertEqual(state['results'][0]['reason'], 'No se pudo leer la carpeta.')


class PathParityTests(unittest.TestCase):
    def test_python_path_key_matches_the_shared_fixture_used_by_the_browser_tests(self):
        from agent_city.store import path_key
        cases = json.loads((Path(__file__).parent / 'path-fixture.json').read_text(encoding='utf-8'))['cases']
        self.assertGreaterEqual(len(cases), 20)
        wrong = [(case['input'], case['key'], path_key(case['input'])) for case in cases if path_key(case['input']) != case['key']]
        self.assertEqual(wrong, [])


class PathMatchingTests(TempCase):
    def store_with(self, *projects):
        store = Store(str(self.base / 'data'))
        self.addCleanup(store.close)
        state = store._load()
        state['organization']['projects'] = [{'id': pid, 'name': pid, 'spaceIds': ['office'], 'path': path} for pid, path in projects]
        with store.db:
            store._write(state)
        store._org_gen += 1
        return store

    def test_windows_copy_as_path_quotes_are_ignored(self):
        store = self.store_with(('p1', '"C:\\Work\\One"'))
        self.assertEqual(store.project_for_cwd('C:\\Work\\One\\src'), 'p1')
        self.assertEqual(store.project_for_cwd('"c:/work/one/"'), 'p1')
        self.assertEqual(store.project_for_cwd('C:\\Work\\One-other'), '')

    def test_a_tie_between_equal_paths_goes_to_the_first_project(self):
        store = self.store_with(('zzz', 'C:\\Work\\Same'), ('aaa', 'C:\\Work\\Same'))
        self.assertEqual(store.project_for_cwd('C:\\Work\\Same\\x'), 'zzz')
        self.assertEqual(store.project_for_cwd('C:\\Work\\Same'), 'zzz')


class RegistryClaimTests(TempCase):
    def test_a_second_city_does_not_steal_the_hook_registry_from_a_live_one(self):
        from agent_city import __main__ as entry
        from agent_city.live import registry_file, write_registry
        home = self.base / 'home'
        home.mkdir()
        with mock.patch.dict('os.environ', {'AGENT_CITY_HOME': str(home)}):
            first_store = Store(str(self.base / 'a'))
            self.addCleanup(first_store.close)
            first = make_server(first_store, 0)
            threading.Thread(target=first.serve_forever, daemon=True).start()
            self.addCleanup(first.server_close)
            self.addCleanup(first.shutdown)
            write_registry(first.server_address[1], first.ingest_token)
            before = registry_file().read_text(encoding='utf-8')

            def second_city():
                with mock.patch.object(sys, 'argv', ['agent_city', '--port', '0', '--data-dir', str(self.base / 'b')]):
                    entry.main()

            real = entry.make_server
            made = []

            def capture(store, port):
                server = real(store, port)
                made.append(server)
                threading.Timer(0.8, server.shutdown).start()
                return server

            with mock.patch.object(entry, 'make_server', side_effect=capture):
                second_city()
            self.assertTrue(made)
            self.assertEqual(registry_file().read_text(encoding='utf-8'), before)


class ServerRobustnessTests(TempCase):
    def setUp(self):
        super().setUp()
        web = self.base / 'web'
        web.mkdir()
        (web / 'index.html').write_text('<!doctype html>City', encoding='utf-8')
        self.store = Store(str(self.base / 'data'))
        self.addCleanup(self.store.close)
        self.server = make_server(self.store, port=0, web_dir=web)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]
        self.origin = 'http://127.0.0.1:%d' % self.port

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def login(self):
        _, headers, _ = self.request('GET', '/')
        cookie = headers['Set-Cookie'].split(';')[0]
        auth = {'Cookie': cookie, 'Sec-Fetch-Site': 'same-origin'}
        status, _, data = self.request('GET', '/api/bootstrap', headers=auth)
        self.assertEqual(status, 200)
        return auth, json.loads(data)['csrfToken']

    def test_an_unexpected_exception_still_answers_with_a_json_error(self):
        auth, token = self.login()
        headers = {**auth, 'Origin': self.origin, 'X-CSRF-Token': token, 'Content-Type': 'application/json'}
        with mock.patch.object(self.store, 'refresh_root', side_effect=RecursionError('boom')):
            status, _, data = self.request('POST', '/api/roots/' + 'a' * 24 + '/refresh', '{}', headers)
        self.assertEqual(status, 500)
        self.assertIn('error', json.loads(data))
        self.assertEqual(self.request('GET', '/api/bootstrap', headers=auth)[0], 200)  # server still healthy

    def test_many_concurrent_page_loads_keep_the_session_table_consistent(self):
        failures, cookies = [], []

        def load():
            for _ in range(40):
                try:
                    status, headers, _ = self.request('GET', '/')
                    if status != 200:
                        failures.append(status)
                    else:
                        cookies.append(headers['Set-Cookie'].split(';')[0])
                except Exception as error:  # noqa: BLE001 - any error here is a failure of the test
                    failures.append(repr(error))

        threads = [threading.Thread(target=load) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(failures, [])
        newest = {'Cookie': cookies[-1], 'Sec-Fetch-Site': 'same-origin'}
        self.assertEqual(self.request('GET', '/api/bootstrap', headers=newest)[0], 200)


if __name__ == '__main__':
    unittest.main()
