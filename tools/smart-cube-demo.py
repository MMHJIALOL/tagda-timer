"""Run the hardware-free demo on its own localhost origin."""
from pathlib import Path
import sys
import threading
import webbrowser

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve import Handler, Server

PORT = 5387
URL = f"http://127.0.0.1:{PORT}/smart-cube-demo.html"

if __name__ == "__main__":
    try:
        server = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Port {PORT} is already in use. If the demo is running, open {URL}", flush=True)
        sys.exit(1)
    print(f"Smart cube local demo: {URL}", flush=True)
    print("Sample history stays on this demo origin. Press Ctrl+C to stop.", flush=True)
    if "--no-browser" not in sys.argv:
        threading.Timer(.5, lambda: webbrowser.open(URL)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
