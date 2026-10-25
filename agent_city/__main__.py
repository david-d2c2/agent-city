"""Run with python -m agent_city; no packages or provider keys required."""
import argparse
import http.client
import json
from pathlib import Path
import sys
import sqlite3
import threading
import time
import webbrowser

from .live import registry_file, remove_registry, write_registry
from .server import make_server
from .store import Store, default_data_dir


def registry_info():
    """(port, token) from the user-private registry, or None when absent or malformed."""
    try:
        info = json.loads(registry_file().read_text(encoding='utf-8'))
        port, token = info['port'], info['token']
        if type(port) is int and isinstance(token, str) and token:
            return port, token
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def city_call(method, port, path, token):
    """Authenticated request to the local city; the HTTP status, or None when nothing answers."""
    try:
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=1.5)
        conn.request(method, path, headers={'Authorization': 'Bearer ' + token})
        return conn.getresponse().status
    except (OSError, http.client.HTTPException):
        return None


def city_running(port):
    """True only when the city that published the registry token answers on this port (a look-alike cannot)."""
    info = registry_info()
    return bool(info) and info[0] == port and city_call('GET', port, '/api/ping', info[1]) == 204


def stop_city():
    """Ask the registered city to exit through its token-protected channel; no process is ever killed by pid."""
    info = registry_info()
    if not info or city_call('POST', info[0], '/api/shutdown', info[1]) != 204:
        return 'Agent City no está en marcha.'
    for _ in range(30):  # give it a moment to close its listener
        if city_call('GET', info[0], '/api/ping', info[1]) is None:
            break
        time.sleep(0.1)
    return 'Agent City se ha detenido.'


def main():
    parser = argparse.ArgumentParser(description='Ciudad de agentes: catálogo y organización local.')
    parser.add_argument('--data-dir', help='Carpeta privada para SQLite y copia de seguridad.')
    parser.add_argument('--port', type=int, default=4317)
    parser.add_argument('--open', action='store_true', help='Abrir el navegador local.')
    parser.add_argument('--stop', action='store_true', help='Detener la ciudad que está en marcha.')
    args = parser.parse_args()
    if args.stop:
        message = stop_city()
        print(message)
        parser.exit(0 if message.endswith('detenido.') else 1)
    if sys.stdout is None or sys.stderr is None:  # windowless start (pythonw): keep messages in a log
        try:
            folder = Path(args.data_dir) if args.data_dir else default_data_dir()
            folder.mkdir(parents=True, exist_ok=True)
            log = open(folder / 'agent-city.log', 'a', encoding='utf-8', buffering=1)
            sys.stdout, sys.stderr = sys.stdout or log, sys.stderr or log
        except OSError:
            pass
    if city_running(args.port):
        if args.open:
            webbrowser.open('http://127.0.0.1:' + str(args.port))
        print('Agent City ya está en marcha en el puerto ' + str(args.port) + '.', flush=True)
        return
    store = None
    try:
        store = Store(args.data_dir)
        server = make_server(store, args.port)
    except (OSError, sqlite3.Error, OverflowError):
        if store is not None:
            store.close()
        parser.exit(1, 'No se pudo iniciar: comprueba el puerto local y los permisos de la carpeta de datos.\n')
    threading.Thread(target=store.suggested_roots, daemon=True).start()  # warm source discovery before the first page load
    url = 'http://127.0.0.1:' + str(server.server_address[1])
    print('Ciudad de agentes disponible en ' + url, flush=True)
    try:
        # Hooks follow the registry: a second city (another port, a test copy) must not steal it from one that is alive.
        other = registry_info()
        if other and other[0] != server.server_address[1] and city_call('GET', other[0], '/api/ping', other[1]) == 204:
            print('Aviso: ya hay otra ciudad recibiendo los hooks (puerto %d); esta no los recibirá.' % other[0], file=sys.stderr, flush=True)
        else:
            write_registry(server.server_address[1], server.ingest_token)
    except OSError:
        print('Aviso: no se pudo publicar el registro local; la actividad en vivo no estará disponible.', file=sys.stderr, flush=True)
    if args.open:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        remove_registry(server.ingest_token)
        server.server_close()
        store.close()


if __name__ == '__main__':
    main()
