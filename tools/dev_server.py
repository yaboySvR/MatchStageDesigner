"""
Local server for working on the web app: like `python -m http.server`, but it
tells the browser not to cache, so edited JS / CSS always loads fresh.

  python web/tools/dev_server.py [port]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(NoCacheHandler, directory=str(WEB)))
    print(f"Serving {WEB} at http://localhost:{port}")
    server.serve_forever()
