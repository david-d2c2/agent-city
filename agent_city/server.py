"""Loopback-only HTTP transport with browser session, origin and CSRF checks."""
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import threading
import time
from urllib.parse import urlsplit

from .discover import list_folders
from .live import LiveState, connect_info, normalize_event, registry_file, usage_of
from .store import Conflict
from .usage_import import import_claude_history

STATIC = {'/': ('index.html', 'text/html'), '/index.html': ('index.html', 'text/html'), '/styles.css': ('styles.css', 'text/css'), '/app.js': ('app.js', 'text/javascript'), '/scene.js': ('scene.js', 'text/javascript'), '/model.js': ('model.js', 'text/javascript'), '/city3d.js': ('city3d.js', 'text/javascript'), '/city3d-layout.js': ('city3d-layout.js', 'text/javascript'), '/vendor/three.module.js': ('vendor/three.module.js', 'text/javascript'), '/vendor/three.core.js': ('vendor/three.core.js', 'text/javascript')}


class LocalHTTPServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR otherwise permits two listeners on the same port.
    allow_reuse_address = False


def make_server(store, port=4317, web_dir=None):
    web = Path(web_dir) if web_dir else Path(__file__).resolve().parent.parent / 'web'
    sessions = {}
    sessions_lock = threading.Lock()  # handler threads mint, prune and read sessions concurrently

    class Handler(BaseHTTPRequestHandler):
        server_version = 'AgentCity'

        def log_message(self, *args):
            pass

        def respond(self, status, data, content_type='application/json', cookie=None):
            if isinstance(data, (dict, list)):
                data = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', content_type + '; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.send_header('Connection', 'close')
            if cookie:
                self.send_header('Set-Cookie', 'agentcity=' + cookie + '; Path=/; HttpOnly; SameSite=Strict')
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def error(self, status, message):
            # Drain a bounded rejected body so Windows can deliver the response
            # before closing a socket with unread incoming data.
            if self.command in ('POST', 'PUT') and not getattr(self, 'body_read', False):
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    self.connection.settimeout(0.25)
                    if 0 < length <= 1048577:
                        self.rfile.read(length)
                except (OSError, ValueError):
                    pass
            self.respond(status, {'error': message})

        def authorized(self):
            # Hooks and the launcher authenticate with the per-start bearer token; they never carry browser credentials.
            if self.headers.get('Origin') is not None:
                self.error(403, 'Origen no permitido.')
                return False
            supplied = self.headers.get('Authorization', '').encode('utf-8', 'replace')
            if not secrets.compare_digest(supplied, ('Bearer ' + self.server.ingest_token).encode('utf-8')):
                self.error(401, 'No autorizado.')
                return False
            return True

        def control(self, path):
            # Launcher control channel: proves this port is the city that published the registry token, and lets
            # --stop ask it to exit instead of killing a pid read from a file.
            if not self.authorized():
                return
            if path == '/api/ping':
                return self.respond(204, b'')
            self.respond(204, b'')
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        def ingest(self):
            if not self.authorized():
                return
            try:
                lengths = self.headers.get_all('Content-Length', [])
                if self.headers.get('Transfer-Encoding') or len(lengths) != 1:
                    return self.error(400, 'Longitud de solicitud inválida.')
                length = int(lengths[0])
                if length < 0:
                    return self.error(400, 'Longitud de solicitud inválida.')
                if length > 16384:
                    return self.error(413, 'Solicitud demasiado grande.')
                if self.headers.get_content_type() != 'application/json':
                    return self.error(400, 'Se requiere JSON.')
                raw = self.rfile.read(length)
                self.body_read = True
                body = json.loads(raw)
                if not isinstance(body, dict) or set(body) != {'source', 'event'}:
                    raise ValueError('Evento inválido.')
                event = normalize_event(body['source'], body['event'])
                self.server.live.apply(body['source'], event)
            except (ValueError, TypeError, KeyError, UnicodeError):
                return self.error(400, 'Evento inválido.')
            try:
                # Counting real usage is best effort: a storage problem never fails the hook.
                usage = usage_of(event)
                if usage:
                    cwd = event.get('cwd') or self.server.live.last_cwd(body['source'], event['session_id'])
                    try:
                        project = store.project_for_cwd(cwd)
                    except Exception:  # a resolver hiccup costs the project attribution, never the count itself
                        project = ''
                    store.record_usage(body['source'], *usage, project=project)
            except Exception:
                pass
            self.respond(204, b'')

        def handle_request(self, mutation=False):
            origin = 'http://127.0.0.1:' + str(self.server.server_address[1])
            if self.headers.get_all('Host') != [origin.removeprefix('http://')]:
                return self.error(403, 'Host no permitido.')
            parsed = urlsplit(self.path)
            if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or '%' in parsed.path or '\\' in parsed.path or '..' in parsed.path:
                return self.error(404, 'Ruta no disponible.')
            path = parsed.path
            if not mutation and path == '/favicon.ico':
                return self.respond(204, b'', 'image/x-icon')
            if not mutation and path in STATIC:
                filename, content_type = STATIC[path]
                try:
                    data = (web / filename).read_bytes()
                except OSError:
                    return self.error(404, 'Recurso no disponible.')
                cookie = None
                if path in ('/', '/index.html'):
                    stamp = time.monotonic()
                    cookie = secrets.token_urlsafe(32)
                    with sessions_lock:
                        for key in list(sessions):
                            if sessions[key][1] < stamp - 43200:
                                del sessions[key]
                        while len(sessions) >= 100:
                            sessions.pop(next(iter(sessions)))
                        sessions[cookie] = (secrets.token_urlsafe(32), stamp)
                return self.respond(200, data, content_type, cookie)
            if not path.startswith('/api/'):
                return self.error(404, 'Ruta no disponible.')
            if self.command == 'POST' and path == '/api/ingest':
                return self.ingest()
            if (self.command, path) in (('GET', '/api/ping'), ('POST', '/api/shutdown')):
                return self.control(path)
            try:
                cookies = SimpleCookie(self.headers.get('Cookie', ''))
                with sessions_lock:
                    session = sessions.get(cookies['agentcity'].value) if 'agentcity' in cookies else None
            except Exception:
                session = None
            request_origin = self.headers.get('Origin')
            fetch_site = self.headers.get('Sec-Fetch-Site')
            if session is None or session[1] < time.monotonic() - 43200 or (request_origin is not None and request_origin != origin) or fetch_site not in (None, 'same-origin') or not (request_origin == origin or fetch_site == 'same-origin'):
                return self.error(403, 'Se requiere una sesión del navegador local.')
            if mutation and (request_origin != origin or not secrets.compare_digest(self.headers.get('X-CSRF-Token', ''), session[0])):
                return self.error(403, 'Origen o token de sesión inválido.')
            try:
                body = None
                if mutation:
                    if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1:
                        return self.error(400, 'Longitud de solicitud inválida.')
                    length = int(self.headers['Content-Length'])
                    if length < 0:
                        return self.error(400, 'Longitud de solicitud inválida.')
                    if length > 1048576:
                        return self.error(413, 'Solicitud demasiado grande.')
                    if self.headers.get_content_type() != 'application/json':
                        return self.error(400, 'Se requiere JSON.')
                    raw = self.rfile.read(length)
                    self.body_read = True
                    body = json.loads(raw or b'{}')
                    if not isinstance(body, dict):
                        raise ValueError('Se requiere un objeto JSON.')
                if self.command == 'GET' and path == '/api/live':
                    hook = Path(__file__).resolve().parent.parent / 'hooks' / 'agent_city_hook.py'
                    return self.respond(200, {**self.server.live.snapshot(), 'connect': connect_info(hook, sys.executable, registry_file())})
                if self.command == 'GET' and path == '/api/usage':
                    return self.respond(200, store.usage_summary())
                if self.command == 'POST' and path in ('/api/usage/import-history', '/api/usage/clear'):
                    if body:
                        raise ValueError('Se requiere un objeto JSON vacío.')
                    if path == '/api/usage/clear':
                        store.clear_usage()
                        return self.respond(200, store.usage_summary())
                    try:
                        imported = import_claude_history(store)
                    except ValueError as error:
                        return self.error(400, str(error))
                    return self.respond(200, {'imported': imported, 'usage': store.usage_summary()})
                if self.command == 'GET' and path == '/api/bootstrap':
                    state = store.bootstrap()
                elif self.command == 'POST' and path == '/api/roots':
                    if set(body) != {'path', 'label', 'format'}:
                        raise ValueError('Datos de fuente inválidos.')
                    state = store.approve_root(body['path'], body['label'], body['format'])
                elif self.command == 'POST' and path == '/api/roots/bulk':
                    if set(body) != {'roots'}:
                        raise ValueError('Datos de fuentes inválidos.')
                    state = store.approve_roots(body['roots'])
                elif self.command == 'POST' and path == '/api/projects/scan':
                    if set(body) != {'path'}:
                        raise ValueError('Datos de carpeta inválidos.')
                    folders, truncated = list_folders(body['path'])
                    state = {'folders': folders, 'truncated': truncated}
                elif self.command == 'POST' and re.fullmatch(r'/api/roots/[a-f0-9]{24}/refresh', path):
                    state = store.refresh_root(path.split('/')[3])
                elif self.command == 'PUT' and path == '/api/organization':
                    state = store.save_organization(body)
                elif self.command == 'POST' and path == '/api/organization/undo':
                    state = store.undo()
                else:
                    return self.error(404, 'Ruta no disponible.')
                state['csrfToken'] = session[0]
                self.respond(200, state)
            except Conflict as error:
                self.error(409, str(error))
            except (ValueError, TypeError, KeyError, UnicodeError):
                self.error(400, 'Solicitud inválida; revisa los campos y referencias.')
            except (OSError, sqlite3.Error):
                self.error(500, 'No se pudo guardar o leer el estado local. Se conserva el último estado completo.')
            except Exception:  # never drop the connection without an answer (e.g. RecursionError from a hostile file)
                self.error(500, 'Error interno; se conserva el último estado completo.')

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request(mutation=True)

        def do_PUT(self):
            self.handle_request(mutation=True)

    server = LocalHTTPServer(('127.0.0.1', port), Handler)
    server.live = LiveState()
    server.ingest_token = secrets.token_urlsafe(32)
    return server
