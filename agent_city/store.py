"""Transactional local snapshots and a separate user organization overlay."""
import copy
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time

from .catalog import BIDI_CONTROLS, MAX_BYTES, MAX_DEFINITIONS, MAX_ENTRIES, approved_path, clean_string, normalized, scan
from .discover import discover_roots


SUGGESTION_SECONDS = 10
MAX_BULK_ROOTS = 200
USAGE_KINDS, USAGE_SOURCES = ('agent', 'skill'), ('claude-code', 'codex', 'history')
USAGE_RETENTION_DAYS, USAGE_MAX_ITEMS, USAGE_NAME_LIMIT = 400, 5000, 120


class Conflict(ValueError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def local_day():
    return datetime.now().date().isoformat()


def usage_name(value):
    """Trim and cap a usage name; None for non-strings, empty names and control characters."""
    if not isinstance(value, str):
        return None
    name = value.strip()[:USAGE_NAME_LIMIT].strip()
    return None if not name or any(ord(char) < 32 or ord(char) == 127 or char in BIDI_CONTROLS for char in name) else name


def path_key(value):
    """Comparable form of a folder path; mirrors pathKey in web/model.js (case, slashes and trailing separators ignored)."""
    text = str(value or '').strip()
    if len(text) > 1 and text[0] == text[-1] == '"':  # Windows «Copy as path» wraps the path in double quotes
        text = text[1:-1].strip()
    text = text.replace('\\', '/').lower().strip()
    return text.rstrip('/') if len(text) > 1 else text


def default_data_dir():
    return Path(os.environ.get('LOCALAPPDATA', Path.home() / '.local' / 'share')) / 'AgentCity'


def initial_state():
    labels = [('office', 'Oficina', 'context'), ('home', 'Casa', 'context'), ('library', 'Biblioteca', 'specialty'), ('workshop', 'Taller', 'specialty'), ('studio', 'Estudio', 'specialty'), ('control', 'Torre de control', 'specialty')]
    return {'catalog': [], 'roots': [], 'organization': {'revision': 0, 'spaces': [{'id': key, 'name': name, 'type': key, 'kind': kind} for key, name, kind in labels], 'projects': [], 'assignments': [], 'skillLinks': []}}


class Store:
    def __init__(self, data_dir=None, home=None):
        self.directory = Path(data_dir) if data_dir is not None else default_data_dir()
        self.home = home
        self.suggestions, self.refreshing = None, False
        self._org_gen, self._project_paths = 0, None
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.directory / 'agent-city.sqlite3', check_same_thread=False)
        self.db.execute('PRAGMA busy_timeout=5000')
        self.db.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, organization TEXT NOT NULL)')
        # Usage counters live beside, never inside, the organization state blob.
        self.db.execute('CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO state VALUES (1, ?)', (json.dumps(initial_state()),))
        try:
            self._migrate_usage()
        except BaseException:
            self.db.close()
            raise
        self._backup()

    def _migrate_usage(self):
        """Create the usage table, or rebuild a pre-project one (SQLite cannot alter a primary key) keeping every row with project ''."""
        shape = "day TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL, PRIMARY KEY (day, source, kind, name, project)"
        old = [row[1] for row in self.db.execute('PRAGMA table_info(usage)')]
        if old and 'project' not in old:
            # One-off safety copy of the data about to be rebuilt.
            copy = sqlite3.connect(self.directory / 'agent-city.pre-project-usage.sqlite3')
            try:
                self.db.backup(copy)
            finally:
                copy.close()
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            old = [row[1] for row in self.db.execute('PRAGMA table_info(usage)')]
            if not old:
                self.db.execute('CREATE TABLE usage (' + shape + ')')
            elif 'project' not in old:
                self.db.execute('CREATE TABLE usage_new (' + shape + ')')
                self.db.execute("INSERT INTO usage_new (day, source, kind, name, project, count) SELECT day, source, kind, name, '', count FROM usage")
                self.db.execute('DROP TABLE usage')
                self.db.execute('ALTER TABLE usage_new RENAME TO usage')

    def close(self):
        with self.lock:
            self.db.close()

    def _backup(self):
        backup = sqlite3.connect(self.directory / 'agent-city.backup.sqlite3')
        try:
            self.db.backup(backup)
        finally:
            backup.close()

    def _load(self):
        return json.loads(self.db.execute('SELECT data FROM state WHERE id=1').fetchone()[0])

    def _write(self, state):
        self.db.execute('UPDATE state SET data=? WHERE id=1', (json.dumps(state, ensure_ascii=False),))

    def bootstrap(self):
        with self.lock:
            state = self._load()
        counts = {key: sum(item['validity'] == key for item in state['catalog']) for key in ('valid', 'invalid', 'missing')}
        counts['discovered'] = len(state['catalog'])
        connected = {(normalized(root['path']), root['format']) for root in state['roots']}
        suggested = [{**root, 'connected': (normalized(root['path']), root['format']) in connected} for root in self.suggested_roots()]
        state.update(providers=[], stats=counts, suggestedRoots=suggested)
        return state

    def suggested_roots(self):
        # Discovery walks the file system: the first call computes it, later ones serve it and refresh in the background.
        with self.lock:
            if self.suggestions is None:
                self.suggestions = (time.monotonic(), discover_roots(self.home))
            elif time.monotonic() - self.suggestions[0] > SUGGESTION_SECONDS and not self.refreshing:
                self.refreshing = True
                threading.Thread(target=self._refresh_suggestions, daemon=True).start()
            return self.suggestions[1]

    def _refresh_suggestions(self):
        try:
            roots = discover_roots(self.home)
        except OSError:
            roots = None
        with self.lock:
            self.refreshing = False
            if roots is not None:
                self.suggestions = (time.monotonic(), roots)

    def _checked_root(self, path, label, format):
        if format not in ('roles', 'skills', 'claude-agents'):
            raise ValueError('Formato de fuente no compatible.')
        root_path = approved_path(path)
        # The application never imports its own private database as source metadata.
        if self.directory.resolve().is_relative_to(root_path) or root_path.is_relative_to(self.directory.resolve()):
            raise ValueError('La fuente y los datos privados deben estar separados.')
        label = clean_string(label, required=True, limit=200)
        return root_path, label, hashlib.sha256((normalized(root_path) + ':' + format).encode()).hexdigest()[:24]

    def approve_root(self, path, label, format):
        root_path, label, root_id = self._checked_root(path, label, format)
        with self.lock:
            state = self._load()
            if not any(root['id'] == root_id for root in state['roots']):
                state['roots'].append({'id': root_id, 'path': str(root_path), 'label': label, 'format': format, 'status': 'pending', 'diagnostics': [], 'approvedAt': now()})
                with self.db:
                    self._write(state)
            return self.refresh_root(root_id)

    def approve_roots(self, roots):
        """Approve and refresh many roots; one failing root never aborts the rest. Returns the state plus per-root results."""
        if not isinstance(roots, list) or not 0 < len(roots) <= MAX_BULK_ROOTS:
            raise ValueError('Se esperan entre 1 y %d fuentes.' % MAX_BULK_ROOTS)
        results, state = [], self.bootstrap()
        for root in roots:
            result = {'path': None, 'label': None, 'format': None}
            try:
                if not isinstance(root, dict) or set(root) != {'path', 'label', 'format'}:
                    raise ValueError('Datos de fuente inválidos.')
                result.update(path=str(root['path'])[:4096], label=str(root['label'])[:200], format=str(root['format'])[:30])
                root_id = self._checked_root(root['path'], root['label'], root['format'])[2]
                if any(known['id'] == root_id for known in state['roots']):
                    result.update(status='skipped', reason='Ya estaba conectada.', imported=0)
                else:
                    state = self.approve_root(root['path'], root['label'], root['format'])
                    added = next(known for known in state['roots'] if known['id'] == root_id)
                    imported = sum(item['source']['rootId'] == root_id and item['validity'] == 'valid' for item in state['catalog'])
                    if added['status'] == 'failed':
                        result.update(status='failed', reason='No se pudo leer la carpeta.', imported=0)
                    else:
                        result.update(status='ok', reason='Importación parcial: se omitieron enlaces o se alcanzó algún límite.' if added['status'] == 'partial' else '', imported=imported)
            except Exception as error:  # one hostile or broken source must never abort the others
                result.update(status='failed', reason=str(error) if isinstance(error, ValueError) else 'No se pudo leer la carpeta.', imported=0)
            results.append(result)
        return {**state, 'results': results}

    def refresh_root(self, root_id):
        with self.lock:
            state = self._load()
            root = next((root for root in state['roots'] if root['id'] == root_id), None)
            if root is None:
                raise ValueError('Fuente desconocida.')
            result = scan(root)
            timestamp = now()
            root['discovery'] = {'maxDepth': 8, 'maxDefinitions': MAX_DEFINITIONS, 'maxEntries': MAX_ENTRIES, 'maxFileBytes': MAX_BYTES, 'maxTotalBytes': MAX_DEFINITIONS * MAX_BYTES}
            root.update(status='failed' if result['failed'] else 'success' if result['complete'] else 'partial', diagnostics=result['diagnostics'][:100], lastAttemptAt=timestamp)
            previous = {item['id']: item for item in state['catalog']}
            seen = set()
            for item in result['items']:
                old = previous.get(item['id'])
                seen.add(item['id'])
                if item['validity'] == 'invalid' and old:
                    for key in ('name', 'description', 'specialty', 'digest'):
                        item[key] = old[key]
                    item['details'] = old.get('details', {})
                item['importedAt'] = old.get('importedAt', timestamp) if old else timestamp
                item['lastObservedAt'] = timestamp
                previous[item['id']] = item
            if result['complete']:
                root['lastSuccessAt'] = timestamp
                for item in previous.values():
                    if item['source']['rootId'] == root_id and item['id'] not in seen:
                        item['validity'] = 'missing'
            state['catalog'] = list(previous.values())
            with self.db:
                self._write(state)
            return self.bootstrap()

    @staticmethod
    def _validate(organization, catalog):
        if not isinstance(organization, dict) or set(organization) != {'revision', 'spaces', 'projects', 'assignments', 'skillLinks'}:
            raise ValueError('Organización inválida.')
        if type(organization['revision']) is not int or organization['revision'] < 0:
            raise ValueError('Revisión inválida.')
        for key in ('spaces', 'projects', 'assignments', 'skillLinks'):
            if not isinstance(organization[key], list) or len(organization[key]) > 2000:
                raise ValueError('Colección inválida o demasiado grande.')
        role_ids = {item['id'] for item in catalog if item['kind'] == 'role'}
        skill_ids = {item['id'] for item in catalog if item['kind'] == 'skill'}
        def identifiers(rows, allowed):
            result = set()
            for row in rows:
                if not isinstance(row, dict) or not set(row) <= allowed or not {'id', 'name'} <= set(row):
                    raise ValueError('Registro de organización inválido.')
                identity = row['id']
                if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', identity) or identity in result:
                    raise ValueError('Identidad repetida o inválida.')
                result.add(identity)
                row['name'] = clean_string(row['name'], required=True, limit=200)
            return result
        spaces = identifiers(organization['spaces'], {'id', 'name', 'type', 'kind'})
        for space in organization['spaces']:
            if space.get('kind') not in ('context', 'specialty') or space.get('type') not in ('office', 'home', 'library', 'workshop', 'studio', 'control'):
                raise ValueError('Tipo de espacio inválido.')
        projects = identifiers(organization['projects'], {'id', 'name', 'spaceIds', 'path'})
        context_ids = {space['id'] for space in organization['spaces'] if space['kind'] == 'context'}
        for project in organization['projects']:
            path = project.get('path', '')
            if not isinstance(path, str) or len(path) > 1000 or any(ord(char) < 32 or ord(char) == 127 for char in path):
                raise ValueError('Ruta del proyecto inválida.')
            values = project.get('spaceIds')
            if not isinstance(values, list) or any(not isinstance(value, str) or value not in context_ids for value in values) or len(values) != len(set(values)):
                raise ValueError('Contextos del proyecto inválidos.')
        unique = set()
        for assignment in organization['assignments']:
            if not isinstance(assignment, dict) or not set(assignment) <= {'roleId', 'spaceId', 'projectId'} or not isinstance(assignment.get('roleId'), str) or assignment['roleId'] not in role_ids:
                raise ValueError('Asignación de agente inválida.')
            if not {'spaceId', 'projectId'} & set(assignment):
                raise ValueError('Falta el destino de la asignación.')
            for key, targets in [('spaceId', spaces), ('projectId', projects)]:
                if key in assignment and (not isinstance(assignment[key], str) or assignment[key] not in targets):
                    raise ValueError('Destino de asignación inválido.')
            identity = json.dumps(assignment, sort_keys=True)
            if identity in unique:
                raise ValueError('Asignación repetida.')
            unique.add(identity)
        unique = set()
        for link in organization['skillLinks']:
            if not isinstance(link, dict) or set(link) != {'roleId', 'skillId', 'origin'} or link['origin'] != 'user' or not isinstance(link['roleId'], str) or not isinstance(link['skillId'], str) or link['roleId'] not in role_ids or link['skillId'] not in skill_ids:
                raise ValueError('Relación de skill inválida.')
            identity = (link['roleId'], link['skillId'])
            if identity in unique:
                raise ValueError('Relación repetida.')
            unique.add(identity)

    def save_organization(self, organization):
        organization = copy.deepcopy(organization)
        with self.lock:
            self._backup()
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                state = self._load()
                self._validate(organization, state['catalog'])
                previous = state['organization']
                if organization['revision'] != previous['revision']:
                    raise Conflict('La organización cambió. Recarga antes de guardar.')
                self.db.execute('INSERT INTO history (organization) VALUES (?)', (json.dumps(previous),))
                self.db.execute('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 50)')
                organization['revision'] += 1
                state['organization'] = organization
                self._write(state)
            self._org_gen += 1
            return self.bootstrap()

    def undo(self):
        with self.lock:
            self._backup()
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                row = self.db.execute('SELECT id, organization FROM history ORDER BY id DESC LIMIT 1').fetchone()
                if row is None:
                    raise ValueError('No hay cambios para deshacer.')
                state = self._load()
                previous = json.loads(row[1])
                previous['revision'] = state['organization']['revision'] + 1
                state['organization'] = previous
                self.db.execute('DELETE FROM history WHERE id=?', (row[0],))
                self._write(state)
            self._org_gen += 1
            return self.bootstrap()

    def project_for_cwd(self, cwd):
        """Id of the registered project whose folder contains `cwd` (whole segments, longest folder wins), else ''."""
        target = path_key(cwd) if isinstance(cwd, str) else ''
        if not target:
            return ''
        with self.lock:
            # The parsed folder list is reused until this store saves/undoes the organization or another connection commits.
            stamp = (self._org_gen, self.db.execute('PRAGMA data_version').fetchone()[0])
            if self._project_paths is None or self._project_paths[0] != stamp:
                keys = [(path_key(project.get('path')), project['id']) for project in self._load()['organization']['projects']]
                self._project_paths = (stamp, [(key, identity) for key, identity in keys if key and key != '/'])
            # Longest folder wins; on a tie the first project in organization order does (the browser picks the same one).
            best_length, best_identity = 0, ''
            for key, identity in self._project_paths[1]:
                if len(key) > best_length and (target == key or target.startswith(key + '/')):
                    best_length, best_identity = len(key), identity
        return best_identity

    # Real usage: daily counters per (source, kind, name). Only names and counts are stored, never content.
    def _meta(self, key):
        row = self.db.execute('SELECT value FROM usage_meta WHERE key=?', (key,)).fetchone()
        return row[0] if row else None

    def _set_meta(self, key, value, replace=True):
        self.db.execute('INSERT OR ' + ('REPLACE' if replace else 'IGNORE') + ' INTO usage_meta VALUES (?, ?)', (key, value))

    def _prune_usage(self, today):
        # At most once per day: rows past the retention window go away.
        if self._meta('prunedOn') != today:
            cutoff = (date.fromisoformat(today) - timedelta(days=USAGE_RETENTION_DAYS)).isoformat()
            self.db.execute('DELETE FROM usage WHERE day < ?', (cutoff,))
            self._set_meta('prunedOn', today)

    def record_usage(self, source, kind, name, day=None, project=''):
        """Count one real agent or skill call (optionally in a registered project id); returns False when the input is not a valid usage."""
        name = usage_name(name)
        if source not in USAGE_SOURCES or kind not in USAGE_KINDS or name is None or not isinstance(project, str) or not re.fullmatch(r'([A-Za-z0-9_-]{1,100})?', project):
            return False
        day = day or local_day()
        with self.lock, self.db:
            self.db.execute('INSERT INTO usage (day, source, kind, name, project, count) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(day, source, kind, name, project) DO UPDATE SET count = count + 1', (day, source, kind, name, project))
            if source != 'history':
                self._set_meta('liveSince', day, replace=False)
                if kind == 'skill':
                    self._set_meta('skillTracking', '1')
            self._prune_usage(day)
        return True

    def live_since(self):
        with self.lock:
            return self._meta('liveSince')

    def usage_summary(self, today=None):
        with self.lock:
            today = today or local_day()
            current = date.fromisoformat(today)
            last7, last30 = ((current - timedelta(days=span - 1)).isoformat() for span in (7, 30))
            rows = self.db.execute(
                'SELECT kind, name, SUM(count), SUM(CASE WHEN day BETWEEN ? AND ? THEN count ELSE 0 END), SUM(CASE WHEN day BETWEEN ? AND ? THEN count ELSE 0 END), MAX(day) FROM usage GROUP BY kind, name ORDER BY SUM(count) DESC, name, kind LIMIT ?',
                (last7, today, last30, today, USAGE_MAX_ITEMS)).fetchall()
            per_project = self.db.execute(
                "SELECT project, kind, name, SUM(count), SUM(CASE WHEN day BETWEEN ? AND ? THEN count ELSE 0 END), SUM(CASE WHEN day BETWEEN ? AND ? THEN count ELSE 0 END), MAX(day) FROM usage WHERE project != '' GROUP BY project, kind, name ORDER BY SUM(count) DESC, name, kind, project LIMIT ?",
                (last7, today, last30, today, USAGE_MAX_ITEMS)).fetchall()
            history = json.loads(self._meta('history') or 'null') or {'importedAt': None, 'from': None, 'to': None, 'files': 0, 'skipped': 0}
            return {
                'since': self.db.execute('SELECT MIN(day) FROM usage').fetchone()[0],
                'liveSince': self._meta('liveSince'),
                'skillTracking': self._meta('skillTracking') == '1',
                'history': history,
                'items': [{'kind': kind, 'name': name, 'total': total, 'last7': week, 'last30': month, 'lastAt': last} for kind, name, total, week, month, last in rows],
                'projectItems': [{'projectId': project, 'kind': kind, 'name': name, 'total': total, 'last7': week, 'last30': month, 'lastAt': last} for project, kind, name, total, week, month, last in per_project],
            }

    def has_usage_history(self):
        with self.lock:
            return bool(json.loads(self._meta('history') or 'null'))

    def replace_usage_history(self, counts, files, skipped, today=None, imported_at=None, replace=True):
        """Swap the imported history rows for `counts` {(day, kind, name, project): n}; returns what was kept.

        History never double counts live data: for every (day, kind, name) the calls already recorded live are
        subtracted, so the days after the first live day (the city was closed, or skills were not tracked yet) keep
        whatever the transcripts saw beyond it. With replace=False nothing is written (a partial run must not wipe a
        complete earlier import) and the result says so.
        """
        today = today or local_day()
        floor = (date.fromisoformat(today) - timedelta(days=USAGE_RETENTION_DAYS)).isoformat()
        with self.lock, self.db:
            live = {}
            for day, kind, name, n in self.db.execute("SELECT day, kind, name, SUM(count) FROM usage WHERE source != 'history' GROUP BY day, kind, name"):
                live[(day, kind, name)] = n
            kept, budget = {}, dict(live)
            for key in sorted(counts):
                n = counts[key]
                if key[0] < floor:
                    continue
                cover = min(n, budget.get(key[:3], 0))
                budget[key[:3]] = budget.get(key[:3], 0) - cover
                if n - cover > 0:
                    kept[key] = n - cover
            if not replace:
                days = sorted({key[0] for key in kept})
                result = {kind: sum(n for key, n in kept.items() if key[1] == kind) for kind in USAGE_KINDS}
                result.update(files=files, skipped=skipped, replaced=False, **{'from': days[0] if days else None, 'to': days[-1] if days else None})
                return result
            self.db.execute("DELETE FROM usage WHERE source='history'")
            self.db.executemany("INSERT INTO usage (day, source, kind, name, project, count) VALUES (?, 'history', ?, ?, ?, ?)", [(day, kind, name, project, n) for (day, kind, name, project), n in kept.items()])
            days = sorted({key[0] for key in kept})
            result = {kind: sum(n for key, n in kept.items() if key[1] == kind) for kind in USAGE_KINDS}
            result.update(files=files, skipped=skipped, replaced=True, **{'from': days[0] if days else None, 'to': days[-1] if days else None})
            self._set_meta('history', json.dumps({'importedAt': imported_at or now(), 'from': result['from'], 'to': result['to'], 'files': files, 'skipped': skipped}))
            return result

    def clear_usage(self):
        with self.lock, self.db:
            self.db.execute('DELETE FROM usage')
            self.db.execute('DELETE FROM usage_meta')
