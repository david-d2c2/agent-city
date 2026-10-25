import copy
import http.client
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

try:
    from agent_city import discover
    from agent_city.store import Store, Conflict
    from agent_city.server import make_server
except ImportError:
    Store = None


class Fixture:
    def setUp(self):
        self.assertIsNotNone(Store, 'Local catalog service is not implemented')
        temp_root = Path(__file__).resolve().parent.parent / '.local' / 'tests'
        temp_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        self.store = Store(self.base / 'data')
        self.addCleanup(self.store.close)

    def role(self, name='Ana', file='a.toml'):
        path = self.source / file
        path.write_text('name = "' + name + '"\ndescription = "Desarrolla"\nspecialty = "Código"\nsecret = "NEVER_STORE"\nprompt_file = "../private.txt"\n', encoding='utf-8')
        return path

    def write(self, path, text='---\nname: x\n---\nBODY_SECRET\n'):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def fake_home(self):
        """A home directory with a few tool folders; the plugin 'plug' has two versions, the newer one is 2.0.0."""
        home = self.base / 'home'
        self.write(home / '.claude' / 'agents' / 'one.md')
        self.write(home / '.claude' / 'agents' / 'README.md')
        self.write(home / '.codex' / 'agents' / 'a.toml', 'name = "Ana"\n')
        self.write(home / '.agents' / 'skills' / 'one' / 'SKILL.md')
        self.write(home / '.agents' / 'skills' / 'two' / 'SKILL.md')
        self.write(home / '.agents' / 'skills' / 'node_modules' / 'x' / 'SKILL.md')
        (home / '.gemini' / 'skills').mkdir(parents=True)
        plugin = home / '.claude' / 'plugins' / 'cache' / 'market' / 'plug'
        self.write(plugin / '1.0.0' / 'skills' / 'old' / 'SKILL.md')
        for name in ('new', 'new2'):
            self.write(plugin / '2.0.0' / 'skills' / name / 'SKILL.md')
        self.write(plugin / '2.0.0' / 'agents' / 'helper.md')
        os.utime(plugin / '1.0.0', (1000, 1000))
        os.utime(plugin / '2.0.0', (2000, 2000))
        return home

    def home_store(self, home):
        store = Store(self.base / ('data-' + str(len(list(self.base.glob('data-*'))))), home=home)
        self.addCleanup(store.close)
        return store


class ServiceTests(Fixture, unittest.TestCase):
    def test_import_metadata_identity_and_variants(self):
        path = self.role()
        self.role(file='b.toml')
        state = self.store.approve_root(str(self.source), 'Roles', 'roles')
        self.assertEqual(len(state['catalog']), 2)
        ids = {item['id'] for item in state['catalog']}
        self.assertEqual(len(ids), 2)
        self.assertNotIn('NEVER_STORE', json.dumps(state))
        path.write_text('name="Ana renovada"', encoding='utf-8')
        state = self.store.refresh_root(state['roots'][0]['id'])
        self.assertEqual(ids, {item['id'] for item in state['catalog']})

    def test_skills_read_only_frontmatter_and_invalid_metadata(self):
        (self.source / 'one').mkdir()
        (self.source / 'one' / 'SKILL.md').write_text('---\nname: crear\ndescription: |\n  Primera línea\n  Segunda línea\n---\nBODY_SECRET\n', encoding='utf-8')
        (self.source / 'SKILL.md').write_text('---\nname: [unsupported]\n---\n', encoding='utf-8')
        state = self.store.approve_root(str(self.source), 'Skills', 'skills')
        valid = [i for i in state['catalog'] if i['validity'] == 'valid']
        self.assertEqual(len(valid), 1)
        self.assertIn('Segunda línea', valid[0]['description'])
        self.assertNotIn('BODY_SECRET', json.dumps(state))
        self.assertEqual(state['stats']['invalid'], 1)

    def test_failure_preserves_then_complete_empty_marks_missing(self):
        path = self.role()
        state = self.store.approve_root(str(self.source), 'Roles', 'roles')
        root_id = state['roots'][0]['id']
        moved = self.base / 'moved'
        self.source.rename(moved)
        failed = self.store.refresh_root(root_id)
        self.assertEqual(failed['catalog'][0]['validity'], 'valid')
        self.assertEqual(failed['roots'][0]['status'], 'failed')
        moved.rename(self.source)
        path.unlink()
        empty = self.store.refresh_root(root_id)
        self.assertEqual(empty['catalog'][0]['validity'], 'missing')

    def test_invalid_refresh_keeps_name_and_assignments(self):
        path = self.role()
        state = self.store.approve_root(str(self.source), 'Roles', 'roles')
        item_id = state['catalog'][0]['id']
        organization = state['organization']
        organization['assignments'] = [{'roleId': item_id, 'spaceId': 'office'}]
        self.store.save_organization(organization)
        path.write_text('name = [', encoding='utf-8')
        state = self.store.refresh_root(state['roots'][0]['id'])
        self.assertEqual(state['catalog'][0]['name'], 'Ana')
        self.assertEqual(state['catalog'][0]['validity'], 'invalid')
        self.assertEqual(state['organization']['assignments'][0]['roleId'], item_id)

    def skill(self, name, header, files=()):
        folder = self.source / name
        folder.mkdir()
        (folder / 'SKILL.md').write_text('---\nname: ' + name + '\n' + header + '---\nBODY_SECRET\n', encoding='utf-8')
        for entry in files:
            if entry.endswith('/'):
                (folder / entry).mkdir()
            else:
                (folder / entry).write_text('x', encoding='utf-8')

    def details(self, state):
        return {item['name']: item['details'] for item in state['catalog']}

    def test_skill_allowed_tools_forms_and_flags(self):
        self.skill('plain', 'allowed-tools: Read, Grep Bash(git status)\n')
        self.skill('quoted', 'allowed-tools: "Read, Grep"\n')
        self.skill('flow', "allowed-tools: [Read, 'Grep']\n")
        self.skill('block', 'allowed-tools:\n  - Read\n  - "Grep"\nversion: "1.2"\nlicense: MIT\n')
        self.skill('flags', 'user-invocable: "TRUE"\ndisable-model-invocation: true\n')
        self.skill('flags2', 'user-invocable: false\ndisable-model-invocation: False\n')
        self.skill('none', '')
        found = self.details(self.store.approve_root(str(self.source), 'Skills', 'skills'))
        self.assertEqual(found['plain']['allowedTools'], ['Read', 'Grep', 'Bash(git status)'])
        self.assertEqual(found['quoted']['allowedTools'], ['Read', 'Grep'])
        self.assertEqual(found['flow']['allowedTools'], ['Read', 'Grep'])
        self.assertEqual(found['block']['allowedTools'], ['Read', 'Grep'])
        self.assertEqual((found['block']['version'], found['block']['license']), ('1.2', 'MIT'))
        self.assertEqual((found['flags']['userInvocable'], found['flags']['modelInvocable']), (True, False))
        self.assertEqual((found['flags2']['userInvocable'], found['flags2']['modelInvocable']), (False, True))
        self.assertEqual(found['none'], {'allowedTools': None, 'userInvocable': None, 'modelInvocable': None, 'version': '', 'license': '', 'files': [], 'filesTruncated': False})

    def test_skill_deep_limits_and_bad_fields_do_not_invalidate(self):
        tools = ', '.join('T' + str(n) for n in range(150))
        self.skill('many', 'allowed-tools: ' + tools + '\nversion: ' + 'v' * 201 + '\n')
        self.skill('bad', 'allowed-tools: {oops}\nuser-invocable: maybe\ndisable-model-invocation: [x]\nversion: |\n  multi\n')
        state = self.store.approve_root(str(self.source), 'Skills', 'skills')
        found = self.details(state)
        self.assertEqual(len(found['many']['allowedTools']), 100)
        self.assertEqual(found['many']['version'], '')
        self.assertEqual(state['stats']['invalid'], 0)
        bad = found['bad']
        self.assertEqual((bad['allowedTools'], bad['userInvocable'], bad['modelInvocable'], bad['version']), (None, None, None, ''))

    def test_skill_sibling_files_are_names_only_sorted_and_capped(self):
        self.skill('few', '', ['b.txt', 'a/', 'ref/'])
        self.skill('lots', '', ['f' + str(n).zfill(3) + '.md' for n in range(55)])
        found = self.details(self.store.approve_root(str(self.source), 'Skills', 'skills'))
        self.assertEqual(found['few']['files'], [{'name': 'a', 'kind': 'dir'}, {'name': 'b.txt', 'kind': 'file'}, {'name': 'ref', 'kind': 'dir'}])
        self.assertFalse(found['few']['filesTruncated'])
        self.assertEqual(len(found['lots']['files']), 50)
        self.assertTrue(found['lots']['filesTruncated'])
        self.assertEqual(found['lots']['files'][0]['name'], 'f000.md')
        self.assertNotIn('SKILL.md', json.dumps(found))

    def test_role_instruction_chars_with_and_without_wrapper(self):
        (self.source / 'flat.toml').write_text('name = "Flat"\ndeveloper_instructions = "abcde"\n', encoding='utf-8')
        (self.source / 'wrapped.toml').write_text('[agent]\nname = "Wrapped"\ndeveloper_instructions = "abc"\n', encoding='utf-8')
        (self.source / 'none.toml').write_text('name = "None"\ndeveloper_instructions = 5\n', encoding='utf-8')
        state = self.store.approve_root(str(self.source), 'Roles', 'roles')
        found = self.details(state)
        self.assertEqual(found['Flat'], {'instructionChars': 5})
        self.assertEqual(found['Wrapped'], {'instructionChars': 3})
        self.assertEqual(found['None'], {'instructionChars': 0})
        self.assertNotIn('abcde', json.dumps(state))

    def test_invalid_refresh_keeps_old_details(self):
        path = self.role()
        path.write_text('name = "Ana"\ndeveloper_instructions = "abcd"\n', encoding='utf-8')
        state = self.store.approve_root(str(self.source), 'Roles', 'roles')
        path.write_text('name = [', encoding='utf-8')
        state = self.store.refresh_root(state['roots'][0]['id'])
        self.assertEqual(state['catalog'][0]['validity'], 'invalid')
        self.assertEqual(state['catalog'][0]['details'], {'instructionChars': 4})
        (self.source / 'new.toml').write_text('name = [', encoding='utf-8')
        state = self.store.refresh_root(state['roots'][0]['id'])
        self.assertEqual([i['details'] for i in state['catalog'] if i['source']['relativePath'] == 'new.toml'], [{}])

    def agent(self, name, header='', file=None):
        (self.source / (file or name + '.md')).write_text('---\nname: ' + name + '\n' + header + '---\nBODY_SECRET\n', encoding='utf-8')

    def test_claude_agents_tools_model_kind_and_filters(self):
        self.agent('scalar', 'description: |\n  Línea uno\n  Línea dos\ntools: Read, Grep\nmodel: sonnet\n')
        self.agent('flow', 'tools: [Read, Grep]\nmodel: "  opus "\n')
        self.agent('empty', 'tools: []\n')
        self.agent('block', 'tools:\n  - Read\n  - Bash\n')
        self.agent('absent', '')
        self.agent('bad', 'tools: {oops}\nmodel: ' + 'm' * 101 + '\n')
        self.agent('upper', 'tools: Read\n', file='UPPER.MD')
        (self.source / 'README.md').write_text('---\nname: readme\n---\n', encoding='utf-8')
        (self.source / 'readme.MD').write_text('---\nname: readme2\n---\n', encoding='utf-8')
        (self.source / 'plain.md').write_text('sin cabecera\n', encoding='utf-8')
        state = self.store.approve_root(str(self.source), 'Claude', 'claude-agents')
        found = self.details(state)
        self.assertEqual(set(found) - {''}, {'scalar', 'flow', 'empty', 'block', 'absent', 'bad', 'upper'})
        self.assertEqual(found['scalar'], {'allowedTools': ['Read', 'Grep'], 'model': 'sonnet'})
        self.assertEqual(found['flow'], {'allowedTools': ['Read', 'Grep'], 'model': 'opus'})
        self.assertEqual(found['empty'], {'allowedTools': [], 'model': ''})
        self.assertEqual(found['block']['allowedTools'], ['Read', 'Bash'])
        self.assertEqual(found['absent'], {'allowedTools': None, 'model': ''})
        self.assertEqual(found['bad'], {'allowedTools': None, 'model': ''})
        self.assertEqual(found['upper']['allowedTools'], ['Read'])
        self.assertEqual(state['stats'], {'valid': 7, 'invalid': 1, 'missing': 0, 'discovered': 8})
        for item in state['catalog']:
            self.assertEqual((item['kind'], item['source']['format']), ('role', 'claude-agents'))
        scalar = next(item for item in state['catalog'] if item['name'] == 'scalar')
        self.assertIn('Línea dos', scalar['description'])
        self.assertEqual(scalar['specialty'], '')
        self.assertNotIn('BODY_SECRET', json.dumps(state))

    def test_claude_agent_invalid_refresh_keeps_old_details(self):
        self.agent('keep', 'tools: Read\nmodel: haiku\n')
        state = self.store.approve_root(str(self.source), 'Claude', 'claude-agents')
        (self.source / 'keep.md').write_text('sin cabecera\n', encoding='utf-8')
        state = self.store.refresh_root(state['roots'][0]['id'])
        item = state['catalog'][0]
        self.assertEqual((item['validity'], item['name']), ('invalid', 'keep'))
        self.assertEqual(item['details'], {'allowedTools': ['Read'], 'model': 'haiku'})

    def test_unknown_format_rejected_and_claude_root_suggested(self):
        with self.assertRaises(ValueError):
            self.store.approve_root(str(self.source), 'X', 'agents')
        home = self.fake_home()
        suggested = self.home_store(home).bootstrap()['suggestedRoots']
        self.assertIn({'label': 'Agentes de Claude Code', 'path': str(home / '.claude' / 'agents'), 'format': 'claude-agents', 'count': 1, 'connected': False}, suggested)

    def test_restart_conflicts_validation_and_undo(self):
        state = self.store.bootstrap()
        self.assertEqual(len(state['organization']['spaces']), 6)
        organization = copy.deepcopy(state['organization'])
        organization['projects'] = [{'id': 'client', 'name': 'Cliente', 'spaceIds': ['office']}]
        updated = self.store.save_organization(organization)
        self.assertEqual(updated['organization']['revision'], 1)
        with self.assertRaises(Conflict):
            self.store.save_organization(organization)
        invalid = copy.deepcopy(updated['organization'])
        invalid['assignments'] = [{'roleId': 'unknown', 'spaceId': 'office'}]
        with self.assertRaises(ValueError):
            self.store.save_organization(invalid)
        other = Store(self.base / 'data')
        self.addCleanup(other.close)
        self.assertEqual(other.bootstrap()['organization']['projects'][0]['id'], 'client')
        restored = other.undo()
        self.assertEqual(restored['organization']['projects'], [])
        self.assertEqual(restored['organization']['revision'], 2)
        self.assertTrue((self.base / 'data' / 'agent-city.backup.sqlite3').exists())

    def test_project_path_validation(self):
        organization = copy.deepcopy(self.store.bootstrap()['organization'])
        for path in ('C:/Work/Acme', '', 'x' * 1000):
            organization['projects'] = [{'id': 'p', 'name': 'P', 'spaceIds': ['office'], 'path': path}]
            organization = self.store.save_organization(organization)['organization']
            self.assertEqual(organization['projects'][0]['path'], path)
        for path in ('x' * 1001, 'a\nb', 'a\x00b', 5, None):
            bad = copy.deepcopy(organization)
            bad['projects'][0]['path'] = path
            with self.assertRaises(ValueError):
                self.store.save_organization(bad)
        bad = copy.deepcopy(organization)
        bad['projects'][0]['extra'] = 'x'
        with self.assertRaises(ValueError):
            self.store.save_organization(bad)

    def test_nested_bound_preserves_missing_and_rejects_links(self):
        self.role()
        state = self.store.approve_root(str(self.source), 'Roles', 'roles')
        root_id = state['roots'][0]['id']
        (self.source / 'a.toml').unlink()
        deep = self.source
        for index in range(9):
            deep /= str(index)
            deep.mkdir()
        state = self.store.refresh_root(root_id)
        self.assertEqual(state['roots'][0]['status'], 'partial')
        self.assertEqual(state['catalog'][0]['validity'], 'valid')
        try:
            (self.source / 'escape').symlink_to(self.base / 'data', target_is_directory=True)
        except OSError:
            return
        state = self.store.refresh_root(root_id)
        self.assertTrue(state['roots'][0]['diagnostics'])

    def test_runtime_directories_are_excluded(self):
        self.role()
        for filename in ('credentials.toml', 'secrets.toml', 'auth.toml', 'config.toml'):
            (self.source / filename).write_text('name="Credential store"', encoding='utf-8')
        for directory in ('node_modules', '.git', '__pycache__', 'data', 'logs'):
            excluded = self.source / directory
            excluded.mkdir()
            (excluded / 'secret.toml').write_text('name="Excluded"', encoding='utf-8')
        state = self.store.approve_root(str(self.source), 'Roles', 'roles')
        self.assertEqual([item['name'] for item in state['catalog']], ['Ana'])

    def test_two_thousand_definition_budget_preserves_unobserved_snapshot(self):
        original = self.role()
        state = self.store.approve_root(str(self.source), 'Roles', 'roles')
        original_id = state['catalog'][0]['id']
        original.unlink()
        for index in range(2001):
            (self.source / ('role-' + str(index) + '.toml')).write_text('name="Role"', encoding='utf-8')
        state = self.store.refresh_root(state['roots'][0]['id'])
        self.assertEqual(state['roots'][0]['status'], 'partial')
        self.assertEqual(len(state['catalog']), 2001)
        self.assertEqual(next(item for item in state['catalog'] if item['id'] == original_id)['validity'], 'valid')

    def test_links_survive_restart_and_failed_write_is_atomic(self):
        self.role()
        state = self.store.approve_root(str(self.source), 'Roles', 'roles')
        roles = state['catalog']
        skill_source = self.base / 'skills'
        skill_source.mkdir()
        (skill_source / 'SKILL.md').write_text('---\nname: construir\n---\n', encoding='utf-8')
        state = self.store.approve_root(str(skill_source), 'Skills', 'skills')
        organization = state['organization']
        skill = next(item for item in state['catalog'] if item['kind'] == 'skill')
        organization['projects'] = [{'id': 'shared', 'name': 'Compartido', 'spaceIds': ['office', 'home']}]
        organization['assignments'] = [{'roleId': roles[0]['id'], 'projectId': 'shared'}, {'roleId': roles[0]['id'], 'spaceId': 'workshop'}]
        organization['skillLinks'] = [{'roleId': roles[0]['id'], 'skillId': skill['id'], 'origin': 'user'}]
        self.store.save_organization(organization)
        other = Store(self.base / 'data')
        self.addCleanup(other.close)
        self.assertEqual(other.bootstrap()['organization']['skillLinks'], organization['skillLinks'])
        self.assertEqual(other.bootstrap()['organization']['assignments'], organization['assignments'])
        self.assertEqual(other.bootstrap()['organization']['projects'][0]['spaceIds'], ['office', 'home'])
        before = self.store.bootstrap()['organization']
        self.store.db.execute("CREATE TRIGGER fail_save BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(Exception):
            self.store.save_organization(before)
        self.assertEqual(self.store.bootstrap()['organization'], before)


class DiscoveryTests(Fixture, unittest.TestCase):
    def test_discover_only_existing_folders_with_capped_counts_and_newest_plugin_version(self):
        home = self.fake_home()
        with mock.patch('builtins.open', side_effect=AssertionError('discovery must not open files')):
            found = discover.discover_roots(home)
        by_label = {row['label']: row for row in found}
        self.assertEqual(by_label['Agentes de Claude Code'], {'label': 'Agentes de Claude Code', 'path': str(home / '.claude' / 'agents'), 'format': 'claude-agents', 'count': 1})
        self.assertEqual((by_label['Agentes locales']['format'], by_label['Agentes locales']['count']), ('roles', 1))
        self.assertEqual((by_label['Skills locales']['format'], by_label['Skills locales']['count']), ('skills', 2))
        self.assertEqual(by_label['Plugin plug · skills']['count'], 2)
        self.assertTrue(by_label['Plugin plug · skills']['path'].endswith(os.path.join('plug', '2.0.0', 'skills')))
        self.assertEqual((by_label['Plugin plug · agentes']['format'], by_label['Plugin plug · agentes']['count']), ('claude-agents', 1))
        # Missing folders and folders without definitions (empty .gemini/skills) are not suggested.
        self.assertEqual(len(found), 5)
        self.assertEqual(discover.discover_roots(self.base / 'nothing-here'), [])

    def test_counts_match_what_each_suggestion_really_imports(self):
        home = self.fake_home()
        deep = home / '.agents' / 'skills'
        for index in range(8):
            deep /= 'd' + str(index)
        self.write(deep / 'SKILL.md')
        self.write(deep / 'd8' / 'SKILL.md')
        for directory in ('logs', '.git'):
            self.write(home / '.codex' / 'agents' / directory / 'ignored.toml', 'name = "Ignored"\n')
        self.write(home / '.codex' / 'agents' / 'credentials.toml', 'name = "Credential store"\n')
        store = self.home_store(home)
        suggested = store.bootstrap()['suggestedRoots']
        self.assertTrue(suggested)
        for row in suggested:
            state = store.approve_root(row['path'], row['label'], row['format'])
            root = next(root for root in state['roots'] if root['path'] == str(Path(row['path']).resolve()))
            imported = [item for item in state['catalog'] if item['source']['rootId'] == root['id']]
            self.assertEqual(len(imported), row['count'], row['label'])
        self.assertTrue(all(row['connected'] for row in store.bootstrap()['suggestedRoots']))

    def test_count_limits_and_links(self):
        home = self.fake_home()
        with mock.patch('agent_city.discover.MAX_DEFINITIONS', 1):
            self.assertEqual(discover.count_definitions(home / '.agents' / 'skills', 'skills'), 1)
        with mock.patch('agent_city.discover.MAX_ENTRIES', 1):
            self.assertLessEqual(discover.count_definitions(home / '.agents' / 'skills', 'skills'), 1)
        try:
            (home / '.codex' / 'skills').symlink_to(home / '.agents' / 'skills', target_is_directory=True)
        except OSError:
            return
        self.assertNotIn('Skills de Codex', [row['label'] for row in discover.discover_roots(home)])

    def test_bootstrap_reuses_discovery_and_flags_connected(self):
        home = self.fake_home()
        store = self.home_store(home)
        with mock.patch('agent_city.store.discover_roots', wraps=discover.discover_roots) as spy:
            first = store.bootstrap()['suggestedRoots']
            store.bootstrap()
            self.assertEqual(spy.call_count, 1)
            self.assertFalse(any(row['connected'] for row in first))
            path = str(home / '.claude' / 'agents')
            store.approve_root(path, 'Claude', 'claude-agents')
            after = {row['path']: row for row in store.bootstrap()['suggestedRoots']}
            self.assertTrue(after[path]['connected'])
            self.assertFalse(after[str(home / '.codex' / 'agents')]['connected'])
            self.assertEqual(spy.call_count, 1)
            # A stale cache is served as is while a background refresh recomputes it.
            store.suggestions = (store.suggestions[0] - 60, store.suggestions[1])
            store.bootstrap()
            for _ in range(100):
                if spy.call_count == 2 and not store.refreshing:
                    break
                threading.Event().wait(0.02)
            self.assertEqual(spy.call_count, 2)

    def test_bootstrap_stays_fast_with_cached_discovery(self):
        store = self.home_store(self.fake_home())
        store.bootstrap()
        started = time.perf_counter()
        for _ in range(20):
            store.bootstrap()
        self.assertLess((time.perf_counter() - started) / 20, 0.2)

    def test_list_folders_filters_and_caps(self):
        parent = self.base / 'projects'
        for name in ('beta', 'Alpha', '.hidden', 'node_modules', 'Node_Modules2'):
            (parent / name).mkdir(parents=True)
        (parent / 'file.txt').write_text('x', encoding='utf-8')
        try:
            (parent / 'link').symlink_to(parent / 'beta', target_is_directory=True)
        except OSError:
            pass
        rows, truncated = discover.list_folders(str(parent))
        self.assertEqual([row['name'] for row in rows], ['Alpha', 'beta', 'Node_Modules2'])
        self.assertEqual(rows[0]['path'], str(parent.resolve() / 'Alpha'))
        self.assertFalse(truncated)
        for index in range(300):
            (parent / ('extra' + str(index).zfill(3))).mkdir()
        rows, truncated = discover.list_folders(str(parent))
        self.assertEqual((len(rows), truncated), (300, True))
        for bad in (str(parent / 'file.txt'), str(self.base / 'missing'), '', 5):
            with self.assertRaises(ValueError):
                discover.list_folders(bad)


class BulkRootsTests(Fixture, unittest.TestCase):
    def test_bulk_approves_skips_and_isolates_failures(self):
        other = self.base / 'other'
        other.mkdir()
        self.role()
        (other / 'SKILL.md').write_text('---\nname: solo\n---\n', encoding='utf-8')
        roots = [
            {'path': str(self.source), 'label': 'Roles', 'format': 'roles'},
            {'path': str(self.base / 'missing'), 'label': 'Gone', 'format': 'roles'},
            {'path': str(other), 'label': 'Skills', 'format': 'skills'},
            {'path': str(self.source), 'label': 'Roles again', 'format': 'roles'},
            {'path': str(self.base / 'data'), 'label': 'Private', 'format': 'roles'},
            {'path': str(other), 'label': 'Bad format', 'format': 'agents'},
            {'path': str(other), 'label': '', 'format': 'skills'},
            {'path': str(other)},
            'not a root',
        ]
        state = self.store.approve_roots(roots)
        self.assertEqual([row['status'] for row in state['results']], ['ok', 'failed', 'ok', 'skipped', 'failed', 'failed', 'failed', 'failed', 'failed'])
        self.assertEqual([row['imported'] for row in state['results'][:4]], [1, 0, 1, 0])
        self.assertEqual(state['results'][0]['label'], 'Roles')
        self.assertIn('separados', state['results'][4]['reason'])
        self.assertEqual(len(state['roots']), 2)
        self.assertEqual(state['stats']['valid'], 2)
        self.assertNotIn('NEVER_STORE', json.dumps(state))
        again = self.store.approve_roots(roots[:1] + roots[2:3])
        self.assertEqual([row['status'] for row in again['results']], ['skipped', 'skipped'])
        self.assertEqual(len(again['roots']), 2)

    def test_bulk_limits(self):
        for roots in ([], 'x', None, [{'path': 'a', 'label': 'b', 'format': 'skills'}] * 201):
            with self.assertRaises(ValueError):
                self.store.approve_roots(roots)
        self.role()
        state = self.store.approve_roots([{'path': str(self.source), 'label': 'Dup', 'format': 'roles'}] * 200)
        self.assertEqual([row['status'] for row in state['results']].count('skipped'), 199)

    def test_bulk_imports_discovered_roots(self):
        store = self.home_store(self.fake_home())
        suggested = store.bootstrap()['suggestedRoots']
        state = store.approve_roots([{key: row[key] for key in ('path', 'label', 'format')} for row in suggested])
        self.assertEqual({row['status'] for row in state['results']}, {'ok'})
        self.assertEqual(sum(row['imported'] for row in state['results']), sum(row['count'] for row in suggested))
        self.assertEqual(state['stats']['valid'], state['stats']['discovered'])
        self.assertTrue(all(row['connected'] for row in state['suggestedRoots']))


class HTTPTests(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.web = self.base / 'web'
        self.web.mkdir()
        (self.web / 'index.html').write_text('<!doctype html>City', encoding='utf-8')
        self.server = make_server(self.store, port=0, web_dir=self.web)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]
        self.origin = 'http://127.0.0.1:' + str(self.port)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port)
        self.addCleanup(conn.close)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, dict(response.getheaders()), response.read()

    def session(self):
        status, headers, _ = self.request('GET', '/')
        self.assertEqual(status, 200)
        cookie = headers['Set-Cookie'].split(';')[0]
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        headers = {'Cookie': cookie, 'Sec-Fetch-Site': 'same-origin'}
        status, _, data = self.request('GET', '/api/bootstrap', headers=headers)
        self.assertEqual(status, 200)
        return headers, json.loads(data)['csrfToken']

    def test_browser_boundary_and_csrf(self):
        self.assertEqual(self.request('GET', '/api/bootstrap')[0], 403)
        self.assertEqual(self.request('GET', '/', headers={'Host': 'evil.example'})[0], 403)
        headers, token = self.session()
        self.assertEqual(self.request('GET', '/api/bootstrap', headers={**headers, 'Origin': 'https://evil.example'})[0], 403)
        body = json.dumps({'path': str(self.source), 'label': 'Roles', 'format': 'roles'})
        self.assertEqual(self.request('POST', '/api/roots', body, headers)[0], 403)
        headers.update({'Origin': self.origin, 'X-CSRF-Token': token, 'Content-Type': 'application/json'})
        self.assertEqual(self.request('POST', '/api/roots', body, headers)[0], 200)
        self.assertEqual(self.request('POST', '/api/roots', '[' , headers)[0], 400)
        self.assertEqual(self.request('POST', '/api/roots', '[]', headers)[0], 400)

    def post(self, path, payload, headers, token):
        headers = {**headers, 'Origin': self.origin, 'X-CSRF-Token': token, 'Content-Type': 'application/json'}
        status, _, data = self.request('POST', path, json.dumps(payload), headers)
        return status, json.loads(data)

    def test_bulk_roots_endpoint(self):
        headers, token = self.session()
        root = {'path': str(self.source), 'label': 'Roles', 'format': 'roles'}
        self.assertEqual(self.request('POST', '/api/roots/bulk', json.dumps({'roots': [root]}), headers)[0], 403)
        self.role()
        status, data = self.post('/api/roots/bulk', {'roots': [root, {'path': str(self.base / 'missing'), 'label': 'Gone', 'format': 'skills'}]}, headers, token)
        self.assertEqual(status, 200)
        self.assertEqual([row['status'] for row in data['results']], ['ok', 'failed'])
        self.assertEqual(data['stats']['valid'], 1)
        self.assertIn('csrfToken', data)
        self.assertEqual(self.post('/api/roots/bulk', {'roots': [root]}, headers, token)[1]['results'][0]['status'], 'skipped')
        for payload in ({}, {'roots': []}, {'roots': 'x'}, {'roots': [root] * 201}, {'roots': [], 'extra': 1}):
            self.assertEqual(self.post('/api/roots/bulk', payload, headers, token)[0], 400)

    def test_project_scan_endpoint(self):
        parent = self.base / 'projects'
        for name in ('Beta', 'Alpha', '.git'):
            (parent / name).mkdir(parents=True)
        headers, token = self.session()
        self.assertEqual(self.request('POST', '/api/projects/scan', json.dumps({'path': str(parent)}), headers)[0], 403)
        status, data = self.post('/api/projects/scan', {'path': str(parent)}, headers, token)
        self.assertEqual(status, 200)
        self.assertEqual([row['name'] for row in data['folders']], ['Alpha', 'Beta'])
        self.assertFalse(data['truncated'])
        for payload in ({}, {'path': 5}, {'path': str(self.base / 'missing')}, {'path': str(parent), 'extra': 1}):
            self.assertEqual(self.post('/api/projects/scan', payload, headers, token)[0], 400)
        self.assertEqual(self.request('GET', '/api/projects/scan', headers=headers)[0], 404)

    def test_traversal_unknown_endpoints_and_payload_limits(self):
        self.assertEqual(self.request('GET', '/favicon.ico')[0], 204)
        for path in ['/../private.txt', '/%2e%2e/private.txt', '/agent_city/store.py', '/api/file?path=x']:
            self.assertIn(self.request('GET', path)[0], (403, 404))
        headers, token = self.session()
        headers.update({'Origin': self.origin, 'X-CSRF-Token': token, 'Content-Type': 'application/json'})
        self.assertEqual(self.request('PUT', '/api/organization', ' ' * 1048577, headers)[0], 413)

    def test_3d_static_routes_and_vendor_boundary(self):
        (self.web / 'vendor').mkdir()
        for name in ['city3d.js', 'city3d-layout.js', 'vendor/three.module.js', 'vendor/three.core.js']:
            (self.web / name).write_text('// ' + name, encoding='utf-8')
        (self.web / 'vendor' / 'other.js').write_text('// other', encoding='utf-8')
        (self.web / 'app.js').write_text('// app', encoding='utf-8')
        for path in ['/city3d.js', '/city3d-layout.js', '/vendor/three.module.js', '/vendor/three.core.js', '/app.js']:
            status, headers, data = self.request('GET', path)
            self.assertEqual(status, 200, path)
            self.assertEqual(headers['Content-Type'], 'text/javascript; charset=utf-8')
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
            self.assertIn("script-src 'self'", headers['Content-Security-Policy'])
            self.assertTrue(data.startswith(b'//'))
        for path in ['/vendor/other.js', '/vendor/', '/vendor', '/vendor/../app.js', '/vendor/%2e%2e/app.js']:
            self.assertIn(self.request('GET', path)[0], (403, 404), path)

    def test_occupied_port_reports_readable_error(self):
        result = subprocess.run([sys.executable, '-m', 'agent_city', '--data-dir', str(self.base / 'second'), '--port', str(self.port)], capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('No se pudo iniciar', result.stderr)
        self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
