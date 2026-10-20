"""The admin console's 1v1 rating tools (RATING-PLAN.md phase 4) in a real browser:
a person's rating and Reset, and taking a rated round back from the room inspector,
both with the Strike sheet's "also take back" and with the round's own button.

    python -I tools/verify-rating-admin.py <repo dir> [chromium|firefox]

Needs the same rig as tools/verify-rating-ui.py: the database emulator on 9671, the
Auth emulator on 9673 and `wrangler dev --port 8791` from the repo. It wipes the
emulator's tagda-timer-default-rtdb namespace, blocks every real Firebase host and
fails if anything tried to reach one. Screenshots go to RATING_UI_SHOTS (default:
the system temp folder).
"""
import json, os, re, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')   # names hold → and ’; python -I ignores PYTHONIOENCODING

ROOT = sys.argv[1]
BROWSER = sys.argv[2] if len(sys.argv) > 2 else 'chromium'
BASE = 'http://127.0.0.1:8791'
DB, AUTH, NS = 'http://127.0.0.1:9671', 'http://127.0.0.1:9673', 'tagda-timer-default-rtdb'
SHOTS = os.environ.get('RATING_UI_SHOTS') or os.path.join(tempfile.gettempdir(), 'rating-ui-shots')
PROD = re.compile(r'(firebaseio\.com|firebasedatabase\.app|firebaseapp\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com)$')
PORTS = [('127.0.0.1:9099', '127.0.0.1:9673'), ("'127.0.0.1', 9000", "'127.0.0.1', 9671"), ('http://127.0.0.1:9000', 'http://127.0.0.1:9671')]
EMU_MODULES = re.compile(r'/js/(sync-auth|race-net|config|news|admin-health|admin-live|admin-rooms)\.js')
RUN = str(int(time.time()))[-6:]
BOSS = 'boss' + RUN

passed = failed = 0
blocked = []


def check(name, cond, got=''):
    global passed, failed
    if cond: passed += 1
    else: failed += 1
    print(('ok    ' if cond else 'FAIL  ') + name + ('' if cond else f'   (got {str(got)[:240]})'), flush=True)


def http(method, url, body=None):
    data = None if body is None else (body if isinstance(body, str) else json.dumps(body)).encode()
    r = urllib.request.Request(url, data=data, method=method, headers={'content-type': 'application/json', 'Authorization': 'Bearer owner'})
    with urllib.request.urlopen(r) as f:
        t = f.read().decode()
        return json.loads(t) if t else None


def dbget(path): return http('GET', f'{DB}/{path}.json?ns={NS}')
def dbset(path, v): return http('PUT', f'{DB}/{path}.json?ns={NS}', v)


def seed():
    http('PUT', f'{DB}/.settings/rules.json?ns={NS}', open(ROOT + '/firebase.rules.json', encoding='utf-8').read())
    http('DELETE', f'{DB}/.json?ns={NS}')
    dbset(f'admins/{BOSS}', True)
    out = http('POST', f'{AUTH}/identitytoolkit.googleapis.com/v1/projects/tagda-timer/accounts:batchCreate',
               {'users': [{'localId': BOSS, 'email': f'{BOSS}@example.com', 'providerUserInfo': [{'providerId': 'google.com', 'rawId': f'{BOSS}-g'}]}]})
    if out.get('error'): print('batchCreate:', out['error'])
    now = int(time.time() * 1000)
    rating = lambda r, n, w, l, d, v: {'r': r, 'n': n, 'w': w, 'l': l, 'd': d, 'v': v, 'at': now - 60000}
    dbset('ratings', {
        'gina': rating(1020, 1, 1, 0, 0, 1), 'gail': rating(980, 1, 0, 1, 0, 1),
        'hana': rating(1100, 3, 3, 0, 0, 3), 'hugo': rating(900, 3, 0, 3, 0, 3),
    })
    def room(a, b, ga, gb, marker, struck=None):
        return {
            'meta': {'createdAt': now - 120000, 'event': '333', 'mode': 'wca', 'round': 2, 'phase': 'racing', 'kind': 'duel'},
            'players': {a: {'name': a.title(), 'joinedAt': now - 120000, 'lastSeen': now - 5000}, b: {'name': b.title(), 'joinedAt': now - 120000, 'lastSeen': now - 5000}},
            'acct': {a: {'claim': ga, 'ok': True}, b: {'claim': gb, 'ok': True}},
            'rounds': {'1': {'info': {'scramble': "R U R' U'", 'hash': 'h', 'event': '333', 'startedAt': now - 100000},
                             'results': {a: {'timeMs': 11200, 'hash': 'h', 'submittedAt': now - 90000}, b: {'timeMs': 11900, 'hash': 'h', 'submittedAt': now - 89000}}}},
            'rated': {'1': marker},
            **({'mod': {'struck': {'1': struck}}} if struck else {}),
        }
    dbset('rooms/DUELA', room('alice', 'bob', 'gina', 'gail', {'at': now - 70000, 'alice': {'r': 1020, 'd': 20, 's': 1}, 'bob': {'r': 980, 'd': -20, 's': 0}}))
    dbset('rooms/DUELB', room('hal', 'hex', 'hana', 'hugo', {'at': now - 70000, 'hal': {'r': 1100, 'd': 12, 's': 1}, 'hex': {'r': 900, 'd': -12, 's': 0}},
                              struck={'hal': {'at': now - 30000, 'by': 'someone'}}))


def text(page, sel):
    return page.evaluate("(s) => [...document.querySelectorAll(s)].map(e => e.textContent).join(' | ')", sel)


with sync_playwright() as p:
    os.makedirs(SHOTS, exist_ok=True)
    seed()
    b = getattr(p, BROWSER).launch(**({'channel': 'chrome'} if BROWSER == 'chromium' else {}))
    ctx = b.new_context(service_workers='block', viewport={'width': 1300, 'height': 1000})

    def guard(route):
        host = route.request.url.split('/')[2].split(':')[0]
        if PROD.search(host):
            blocked.append(route.request.url); return route.abort()
        if EMU_MODULES.search(route.request.url) and '127.0.0.1:8791' in route.request.url:
            r = route.fetch(); body = r.text()
            for a, c in PORTS: body = body.replace(a, c)
            return route.fulfill(response=r, body=body)
        return route.continue_()
    ctx.route('**/*', guard)

    def ws(w):
        if PROD.search(w.url.split('/')[2].split(':')[0]): blocked.append(w.url); w.close()
        else: w.connect_to_server()
    ctx.route_web_socket(re.compile('.*'), ws)
    page = ctx.new_page()
    page.on('pageerror', lambda e: print(f'  [pageerror] {str(e)[:200]}'))
    page.set_default_timeout(30000)
    page.goto(f'{BASE}/admin?emu=1')
    page.evaluate("""async ({ sub, email }) => {
      const { getDatabaseHandle } = await import('/js/sync-auth.js');
      const { auth } = await getDatabaseHandle();
      const A = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
      await A.signInWithCredential(auth, A.GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true })));
    }""", {'sub': f'{BOSS}-g', 'email': f'{BOSS}@example.com'})
    page.goto(f'{BASE}/admin?emu=1#people/u/gina')
    page.reload()

    # ---- a person's rating, and Reset ----
    page.wait_for_selector('text=1v1 rating', timeout=30000)
    ok = page.wait_for_function("() => /1020 · 1 rated rounds: 1 won, 0 lost, 0 drawn/.test(document.body.innerText)", timeout=20000) and True
    check('person page: gina\'s rating, rounds and record', ok)
    page.screenshot(path=f'{SHOTS}/{BROWSER}-admin-person.png', full_page=True)
    page.get_by_role('button', name='Reset rating…').click()
    page.get_by_role('button', name=re.compile('^Reset$')).click()
    page.wait_for_function("() => /1000 · 0 rated rounds/.test(document.body.innerText)", timeout=15000)
    g = dbget('ratings/gina')
    check('Reset: back to 1000, no rounds, version bumped', g and g['r'] == 1000 and g['n'] == 0 and g['w'] == 0 and g['v'] == 2, g)
    log = dbget('modLog') or {}
    check('…and logged as ratingReset with what it was', any(e.get('action') == 'ratingReset' and e.get('uid') == 'gina' and (e.get('before') or {}).get('r') == 1020 for e in log.values()), log)

    # ---- strike a rated round, taking the rating back in the same go ----
    page.goto(f'{BASE}/admin?emu=1#mod/room/DUELA')
    page.wait_for_function("() => /Rated: Alice \\+20 → 1020 · Bob −20 → 980/.test(document.body.innerText)", timeout=20000)
    check('room inspector: what round 1 did to both ratings', True)
    page.screenshot(path=f'{SHOTS}/{BROWSER}-admin-room-rated.png', full_page=True)
    page.locator('.ac-entry', has_text='Alice').get_by_role('button', name='Strike').click()
    box = page.locator('.ac-check input[type=checkbox]')
    check('the Strike sheet offers to take the rating back, ticked', box.count() == 1 and box.is_checked())
    page.screenshot(path=f'{SHOTS}/{BROWSER}-admin-strike-sheet.png')
    page.get_by_role('button', name=re.compile('^Strike$')).last.click()
    page.wait_for_function("() => /taken back/.test(document.body.innerText)", timeout=15000)
    a, l = dbget('ratings/gina'), dbget('ratings/gail')
    check('gina was reset since, so she is left alone', a['r'] == 1000 and a['n'] == 0 and a['v'] == 2, a)
    check('gail gets her 20 back, and her loss and round go', l['r'] == 1000 and l['n'] == 0 and l['l'] == 0 and l['v'] == 2, l)
    rev = dbget('rooms/DUELA/rated/1/reversed')
    check('the round is marked taken back, by this admin', rev and rev.get('by') == BOSS, rev)
    check('the time is struck as well', bool(dbget('rooms/DUELA/mod/struck/1/alice')))
    log = dbget('modLog') or {}
    check('logged as strike and as ratingReverse', {'strike', 'ratingReverse'} <= {e.get('action') for e in log.values()}, [e.get('action') for e in log.values()])

    # ---- a round struck earlier: its own Take back button ----
    page.goto(f'{BASE}/admin?emu=1#mod/room/DUELB')
    page.get_by_role('button', name='Take back the rating…').click()
    sheet = text(page, '.ac-sheet, [role=dialog]')
    page.get_by_role('button', name=re.compile('^Take back$')).click()
    # Not the text "taken back": the last step's toast says that too.
    page.get_by_role('button', name='Take back the rating…').wait_for(state='detached', timeout=15000)
    h, u = dbget('ratings/hana'), dbget('ratings/hugo')
    check('Take back: hana 1100 → 1088, 2 rounds, 2 wins', h['r'] == 1088 and h['n'] == 2 and h['w'] == 2 and h['v'] == 4, h)
    check('…hugo 900 → 912, 2 rounds, 2 losses', u['r'] == 912 and u['n'] == 2 and u['l'] == 2 and u['v'] == 4, u)
    check('…and the button is gone, the line says so', page.get_by_role('button', name='Take back the rating…').count() == 0)
    line = page.evaluate("() => [...document.querySelectorAll('.ac-round .ac-entry-meta')].map(e => e.textContent).find(x => x.startsWith('Rated:')) || ''")
    check('…the round says what it did and that it was taken back, by whom', 'Hal +12 → 1100' in line and 'taken back' in line and 'by ' in line, line)
    page.screenshot(path=f'{SHOTS}/{BROWSER}-admin-room-takenback.png', full_page=True)

    check('nothing reached the real Firebase', not blocked, blocked[:5])
    b.close()

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
