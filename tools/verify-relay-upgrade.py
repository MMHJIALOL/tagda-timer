"""Test an existing v153 service-worker cache upgrading to this checkout.

python -u tools/verify-relay-upgrade.py [chromium|firefox]
Requires Python Playwright and git history containing the pre-relay release.
Serves only localhost, uses a fresh profile, and blocks hosted services.
"""
import functools
import http.server
from pathlib import Path
import subprocess
import sys
import threading
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
BASELINE = 'c0a10ff'
FILES = ['index.html', 'js/main.js', 'js/panels.js', 'js/phoneshell.js',
         'js/theme.js', 'js/version.js']
OLD = {name: subprocess.check_output(['git', 'show', f'{BASELINE}:{name}'], cwd=ROOT)
       for name in FILES}
upgraded = False


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        name = urlsplit(self.path).path.lstrip('/') or 'index.html'
        if name in OLD:
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript' if name.endswith('.js') else 'text/html')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            # Git deploys LF text. Normalize the Windows checkout too so CRLF
            # alone cannot masquerade as an HTML change and clear the cache.
            self.wfile.write((ROOT / name).read_text(encoding='utf-8').encode() if upgraded else OLD[name])
        else:
            super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser = getattr(p, sys.argv[1] if len(sys.argv) > 1 else 'chromium').launch()
        context = browser.new_context()
        context.route('https://**/*', lambda route: route.abort())
        page = context.new_page()
        page.goto(base)
        page.wait_for_function('window.tagdatimer?.scramble?.scramble', timeout=90000)
        page.wait_for_function('navigator.serviceWorker.controller', timeout=30000)
        page.evaluate("""() => {
          tagdatimer.setSetting('inspection', false);
          tagdatimer.setSetting('holdTime', 0);
          tagdatimer.setSetting('misfireMs', 0);
          tagdatimer.setSetting('bgMode', 'solid');
        }""")
        page.evaluate("tagdatimer.startRelay(['222', '222'])")
        page.wait_for_function('tagdatimer.scramble?.parts?.length === 2', timeout=90000)
        page.wait_for_timeout(1200)
        # Ensure the user's current HTML and main module are cached, as on
        # a normal repeated visit; don't rely on the asynchronous boot report.
        page.evaluate("""async () => {
          const cache = await caches.open('tagda-v4');
          for (const path of ['/', '/js/main.js?v=153', '/js/theme.js']) {
            await cache.put(path, await fetch(path));
          }
        }""")
        assert page.evaluate('tagdatimer.settings.relaySplitEach === undefined')
        session = page.evaluate('tagdatimer.session.id')
        page.evaluate('document.activeElement?.blur()')
        page.keyboard.press('Space')
        page.wait_for_function("document.body.classList.contains('timing')")
        page.wait_for_timeout(650)
        page.keyboard.press('Space')
        assert page.evaluate('tagdatimer.solves.length') == 0
        assert page.evaluate("document.body.classList.contains('timing')")
        page.wait_for_timeout(650)
        page.keyboard.press('Space')
        page.wait_for_function('tagdatimer.solves.length === 1')
        old_id = page.evaluate('tagdatimer.solves[0].id')
        print('PASS reproduced: cached v153 requires a press per puzzle')
        assert page.evaluate("""async () => {
          const cache = await caches.open('tagda-v4');
          const main = await cache.match('/js/main.js?v=153');
          return main && !(await main.text()).includes('relaySplitEach');
        }"""), 'Baseline timer code must actually be cached before upgrading'

        upgraded = True
        page.reload()
        page.wait_for_function('window.tagdatimer?.scramble?.parts?.length === 2', timeout=90000)
        assert page.evaluate('tagdatimer.settings.relaySplitEach === false'), \
            'Returning visitor still runs cached relay code after a normal reload'
        assert page.evaluate('tagdatimer.session.id') == session
        assert page.evaluate('tagdatimer.solves[0].id') == old_id
        page.evaluate('tagdatimer.openRelayBuilder()')
        expect(page.get_by_role('checkbox', name='Press Space after every puzzle')).not_to_be_checked()
        page.evaluate("async () => (await import('/js/panels.js')).closeDrawer()")
        page.evaluate('document.activeElement?.blur()')
        page.keyboard.press('Space')
        page.wait_for_function("document.body.classList.contains('timing')")
        page.wait_for_timeout(650)
        page.keyboard.press('Space')
        page.wait_for_function('tagdatimer.solves.length === 2')
        assert page.evaluate('tagdatimer.solves.at(-1).relay.every(p => p.splitMs === undefined)')
        print('PASS ordinary reload updates the cached app: one stop saves the relay; existing session and solves remain')
        browser.close()
finally:
    server.shutdown()
