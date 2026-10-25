"""Run with python -m agent_city; no packages or provider keys required."""
import argparse
import http.client
import json
import os
from pathlib import Path
import signal
import sys
import sqlite3
import threading
import webbrowser

from .live import registry_file, remove_registry, write_registry
from .server import make_server
from .store import Store, default_data_dir


def city_running(port):
    """True only when an Agent City answers on this loopback port."""
    try:
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=0.5)
        conn.request('GET', '/favicon.ico')
        return conn.getresponse().getheader('Server', '').startswith('AgentCity')
    except (OSError, http.client.HTTPException):
        return False


def stop_city():
    """Stop the city recorded in the registry, but only after confirming it is really Agent City."""
    try:
        info = json.loads(registry_file().read_text(encoding='utf-8'))
        port, pid = info['port'], info['pid']
        if type(port) is not int or type(pid) is not int:
            raise ValueError
    except (OSError, ValueError, KeyError, TypeError):
        return 'Agent City no está en marcha.'
    if not city_running(port):
        return 'Agent City no está en marcha.'
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return 'No se pudo detener Agent City.'
    try:
        registry_file().unlink()
    except OSError:
        pass
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
