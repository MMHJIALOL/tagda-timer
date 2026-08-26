"""
Tagda Timer development server.

Plain `python -m http.server` lets the browser cache files, so edits appear to
do nothing until you hard-reload. This serves the same folder with caching
switched off, and opens the timer for you.

    python serve.py [port]
"""

import http.server
import os
import socketserver
import sys
import threading
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # App code is never cached, so edits show up on a plain reload. The
        # vendored cubing.js bundle is: it is content-hashed and megabytes wide,
        # and `no-store` makes the browser throw away the <link rel=modulepreload>
        # copy and fetch the whole graph a second time -- which is exactly the
        # first-scramble delay this is meant to avoid.
        if self.path.startswith("/vendor/"):
            self.send_header("Cache-Control", "public, max-age=3600")
        else:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # only report problems, not every asset
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith(("4", "5")):
            sys.stderr.write("  %s %s\n" % (status, args[0] if args else ""))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    url = f"http://localhost:{PORT}"
    try:
        httpd = Server(("", PORT), Handler)
    except OSError as e:
        print(f"Could not start on port {PORT}: {e}")
        print(f"Something else may already be using it. Try: python serve.py {PORT + 1}")
        return 1

    print("=" * 52)
    print("  Tagda Timer is running")
    print(f"  {url}")
    print("=" * 52)
    print("  Close this window to stop the server.")
    print()

    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
