"""Run with python -m agent_city; no packages or provider keys required."""
import argparse
import sys
import sqlite3
import threading
import webbrowser

from .live import remove_registry, write_registry
from .server import make_server
from .store import Store


def main():
    parser = argparse.ArgumentParser(description='Ciudad de agentes: catálogo y organización local.')
    parser.add_argument('--data-dir', help='Carpeta privada para SQLite y copia de seguridad.')
    parser.add_argument('--port', type=int, default=4317)
    parser.add_argument('--open', action='store_true', help='Abrir el navegador local.')
    args = parser.parse_args()
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
