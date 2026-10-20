"""A random 1v1's ratings in real browsers (RATING-PLAN.md §8): two signed-in players
rated and shown on both cards, the drawer before and after, and a signed-out player
against a signed-in one with both "not rated" notes.

    python -I tools/verify-rating-ui.py <repo dir> [chromium|firefox]

Needs, all on 127.0.0.1 and nothing real:
  - the database emulator on 9671 and the Auth emulator on 9673 (firebase-tools 13,
    `emulators:start --only database,auth --project tagda-timer`);
  - `wrangler dev --port 8791` from the repo, whose .dev.vars has RTDB_URL=http://127.0.0.1:9671,
    RTDB_NS=tagda-timer-default-rtdb, AUTH_URL=http://127.0.0.1:9673/identitytoolkit.googleapis.com,
    a made-up FIREBASE_SERVICE_ACCOUNT and CONFIG_TTL_MS=1500 (tools/sotd-replay-dev.mjs shows how).
The page's ?emu=1 hard-codes 9000/9099, so this rewrites those ports in the four modules
that hold them. It wipes the emulator's tagda-timer-default-rtdb namespace, blocks every
real Firebase host (http and websocket) and fails if anything tried to reach one.
Screenshots go to RATING_UI_SHOTS (default: the system temp folder).
"""
import json, os, re, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = sys.argv[1]
BROWSER = sys.argv[2] if len(sys.argv) > 2 else 'chromium'
BASE = 'http://127.0.0.1:8791'
DB, AUTH, NS = 'http://127.0.0.1:9671', 'http://127.0.0.1:9673', 'tagda-timer-default-rtdb'
SHOTS = os.environ.get('RATING_UI_SHOTS') or os.path.join(tempfile.gettempdir(), 'rating-ui-shots')
PROD = re.compile(r'(firebaseio\.com|firebasedatabase\.app|firebaseapp\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com)$')
PORTS = [('127.0.0.1:9099', '127.0.0.1:9673'), ("'127.0.0.1', 9000", "'127.0.0.1', 9671"), ('http://127.0.0.1:9000', 'http://127.0.0.1:9671')]

RUN = str(int(time.time()))[-6:]
U = {'gina': 'gina' + RUN, 'gail': 'gail' + RUN}
passed = failed = 0
blocked = []


def check(name, cond, got=''):
    global passed, failed
    if cond: passed += 1
    else: failed += 1
    print(('ok    ' if cond else 'FAIL  ') + name + ('' if cond else f'   (got {str(got)[:200]})'), flush=True)


def http(method, url, body=None, owner=True):
    data = None if body is None else (body if isinstance(body, str) else json.dumps(body)).encode()
    h = {'content-type': 'application/json', **({'Authorization': 'Bearer owner'} if owner else {})}
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(r) as f:
        t = f.read().decode()
        return json.loads(t) if t else None


def dbget(path): return http('GET', f'{DB}/{path}.json?ns={NS}')


def setup():
    http('PUT', f'{DB}/.settings/rules.json?ns={NS}', open(ROOT + '/firebase.rules.json', encoding='utf-8').read())
    http('DELETE', f'{DB}/.json?ns={NS}')
    http('PUT', f'{DB}/admins.json?ns={NS}', {'boss': True})
    users = [{'localId': u, 'email': f'{u}@example.com', 'providerUserInfo': [{'providerId': 'google.com', 'rawId': f'{u}-g'}]}
             for u in U.values()]
    out = http('POST', f'{AUTH}/identitytoolkit.googleapis.com/v1/projects/tagda-timer/accounts:batchCreate', {'users': users})
    if out.get('error'): print('batchCreate:', out['error'])


def context(b, name):
    ctx = b.new_context(service_workers='block', viewport={'width': 1300, 'height': 900})

    def guard(route):
        host = route.request.url.split('/')[2].split(':')[0]
        if PROD.search(host):
            blocked.append(route.request.url); return route.abort()
        if re.search(r'/js/(sync-auth|race-net|config|news)\.js', route.request.url) and '127.0.0.1:8791' in route.request.url:
            r = route.fetch(); body = r.text()
            for a, c in PORTS: body = body.replace(a, c)
            return route.fulfill(response=r, body=body)
        return route.continue_()
    ctx.route('**/*', guard)

    def ws(w):
        if PROD.search(w.url.split('/')[2].split(':')[0]):
            blocked.append(w.url); w.close()
        else:
            w.connect_to_server()
    ctx.route_web_socket(re.compile('.*'), ws)
    page = ctx.new_page()
    page.on('console', lambda m: m.type == 'error' and print(f'  [{name} console] {m.text[:160]}'))
    page.on('pageerror', lambda e: print(f'  [{name} pageerror] {str(e)[:200]}'))
    page.set_default_timeout(30000)
    page.goto(f'{BASE}/?emu=1')
    page.wait_for_selector('#btn-race')
    return ctx, page


def sign_in(page, user):
    page.evaluate("""async ({ sub, email }) => {
      const { getDatabaseHandle } = await import('/js/sync-auth.js');
      const { auth } = await getDatabaseHandle();
      const A = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
      await A.signInWithCredential(auth, A.GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true })));
    }""", {'sub': f'{U[user]}-g', 'email': f'{U[user]}@example.com'})
    page.reload()
    page.wait_for_selector('#btn-race')
    uid = page.evaluate("""async () => { const { getDatabaseHandle } = await import('/js/sync-auth.js');
      const { auth } = await getDatabaseHandle(); await auth.authStateReady?.(); return auth.currentUser?.uid || null; }""")
    return uid


def open_drawer(page):
    page.click('#btn-race')
    page.wait_for_selector('.duel-card')


def close_drawer(page):
    if page.locator('#drawer-close').is_visible():
        page.click('#drawer-close')
        page.wait_for_timeout(300)


def find(page):
    open_drawer(page)
    page.get_by_role('button', name=re.compile('Find an opponent|Try again')).click()


def wait_board(page, ms=45000):
    page.wait_for_selector('.duel-board', timeout=ms)


def solve(page, ms=3600):
    page.bring_to_front()
    page.keyboard.down('Space'); page.keyboard.up('Space')      # inspection
    page.wait_for_timeout(800)
    page.keyboard.down('Space'); page.wait_for_timeout(60); page.keyboard.up('Space')  # start
    page.wait_for_timeout(ms)
    page.keyboard.down('Space'); page.wait_for_timeout(60); page.keyboard.up('Space')  # stop


def card(page):
    return page.evaluate("""() => [...document.querySelectorAll('.duel-board-side')].map(s => ({
      who: s.dataset.who, state: s.dataset.state,
      elo: s.querySelector('.duel-board-elo')?.textContent || '',
      eloVisible: !!(s.querySelector('.duel-board-elo')?.getBoundingClientRect().width),
      dir: s.querySelector('.duel-board-elo b')?.dataset.dir || '',
    })).concat([{ note: document.querySelector('.duel-rating-note')?.textContent || '' }])""")


def wait_for(page, pred_js, ms, arg=None):
    end = time.time() + ms / 1000
    while time.time() < end:
        if page.evaluate(pred_js, arg): return True
        page.wait_for_timeout(400)
    return False


with sync_playwright() as p:
    os.makedirs(SHOTS, exist_ok=True)
    setup()
    b = getattr(p, BROWSER).launch(**({'channel': 'chrome'} if BROWSER == 'chromium' else {}))
    on = json.loads(urllib.request.urlopen(f'{BASE}/rate').read().decode())
    check('GET /rate says ratings are on', on.get('on') is True, on)

    ca, a = context(b, 'A'); cb, bb = context(b, 'B')
    ua, ub = sign_in(a, 'gina'), sign_in(bb, 'gail')
    check('A signs in as gina', ua == U['gina'], ua)
    check('B signs in as gail', ub == U['gail'], ub)

    # The drawer before any 1v1: a new account.
    open_drawer(a)
    ok = wait_for(a, "() => { const l = document.querySelector('.duel-rating'); return l && !l.hidden && l.textContent.includes('1000'); }", 15000)
    check('drawer: a new account is told it starts at 1000', ok, a.evaluate("() => document.querySelector('.duel-rating')?.outerHTML"))
    a.screenshot(path=f'{SHOTS}/{BROWSER}-drawer-new.png')
    close_drawer(a)

    find(a); a.wait_for_timeout(1500); find(bb)
    wait_board(a); wait_board(bb)
    close_drawer(a); close_drawer(bb)
    check('both are in a 1v1', True)

    ok = wait_for(a, "() => document.querySelectorAll('.duel-board-elo').length === 2", 20000)
    c = card(a)
    check('card at the start: both ratings, 1000 each', ok and all('1000' in s.get('elo', '') for s in c[:2]), c)
    a.screenshot(path=f'{SHOTS}/{BROWSER}-card-start.png')

    # Round 1: both solve.
    wait_for(a, "() => document.querySelector('.duel-board-round')?.textContent.includes('1')", 20000)
    a.wait_for_timeout(1500)
    solve(a, 3600); solve(bb, 4300)
    ok = wait_for(a, "() => [...document.querySelectorAll('.duel-board-side')].every(s => s.dataset.state === 'time')", 30000) or True
    t0 = time.time()
    ok = wait_for(a, "() => document.querySelectorAll('.duel-board-elo b').length === 2", 45000)
    took = time.time() - t0
    ca_ = card(a); cb_ = card(bb)
    check(f'after round 1 the change shows on A\'s card ({took:.0f} s after the times)', ok, ca_)
    ok_b = wait_for(bb, "() => document.querySelectorAll('.duel-board-elo b').length === 2", 10000)
    cb_ = card(bb)
    check('…and on B\'s', ok_b, cb_)
    rated = dbget('rooms') or {}
    room = next((k for k, v in rated.items() if (v or {}).get('meta', {}).get('kind') == 'duel' and k != '_1v1_333'), None)
    marker = dbget(f'rooms/{room}/rated/1') if room else None
    check('round 1 is rated in the database', marker and len([k for k in marker if k not in ('at', 'skip')]) == 2, marker)
    gina, gail = dbget(f"ratings/{ua}"), dbget(f"ratings/{ub}")
    check('ratings/gina and ratings/gail: ±20 from 1000, one rated round each',
          gina and gail and sorted([gina['r'], gail['r']]) == [980, 1020] and gina['n'] == gail['n'] == 1, (gina, gail))
    me_a = next(s for s in ca_ if s.get('who') == 'me'); them_a = next(s for s in ca_ if s.get('who') == 'them')
    check("A's card: own rating is gina's, theirs is gail's", str(gina['r']) in me_a['elo'] and str(gail['r']) in them_a['elo'], ca_)
    check('A\'s card: winner up, loser down', {me_a['dir'], them_a['dir']} == {'up', 'down'}, ca_)
    check('the card shows no "not rated" note', ca_[-1]['note'] == '' and cb_[-1]['note'] == '', (ca_[-1], cb_[-1]))
    vis = a.evaluate("""() => [...document.querySelectorAll('.duel-board-elo')].map(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom <= innerHeight; })""")
    check('the ratings are visible on screen', all(vis) and len(vis) == 2, vis)
    a.screenshot(path=f'{SHOTS}/{BROWSER}-card-rated-A.png')
    bb.screenshot(path=f'{SHOTS}/{BROWSER}-card-rated-B.png')

    # Out of the 1v1: the drawer shows your rating now.
    a.get_by_role('button', name=re.compile('Quit 1v1')).first.click()
    a.get_by_role('button', name=re.compile(r'^quit$', re.I)).click()
    a.wait_for_selector('.duel-board', state='hidden')
    a.wait_for_timeout(800)
    open_drawer(a)
    want = f"{gina['r']} · 1 rated round"
    ok = wait_for(a, "(w) => { const l = document.querySelector('.duel-rating'); return l && !l.hidden && l.textContent.includes(w); }", 15000, want)
    check(f'drawer after: "{want}"', ok, a.evaluate("() => document.querySelector('.duel-rating')?.textContent"))
    a.screenshot(path=f'{SHOTS}/{BROWSER}-drawer-rated.png')
    close_drawer(a)
    bb.wait_for_timeout(12000)   # B sees A gone and leaves the 1v1

    # A signed-out player against B.
    cc, c3 = context(b, 'C')
    open_drawer(c3)
    ok = wait_for(c3, "() => { const l = document.querySelector('.duel-rating'); return l && !l.hidden && /Sign in/.test(l.textContent); }", 15000)
    check('drawer, signed out: "Sign in to get a rating"', ok, c3.evaluate("() => document.querySelector('.duel-rating')?.outerHTML"))
    close_drawer(c3)
    find(bb); bb.wait_for_timeout(1500); find(c3)
    wait_board(bb); wait_board(c3)
    close_drawer(bb); close_drawer(c3)
    ok = wait_for(c3, "() => /Sign in to get a rating/.test(document.querySelector('.duel-rating-note')?.textContent || '')", 15000)
    check('signed-out card: "Sign in to get a rating" at once', ok, card(c3))
    c3.screenshot(path=f'{SHOTS}/{BROWSER}-card-signedout.png')
    bb.wait_for_timeout(1500)
    solve(bb, 3600); solve(c3, 4200)
    ok = wait_for(bb, "() => /isn’t signed in, so this 1v1 isn’t rated/.test(document.querySelector('.duel-rating-note')?.textContent || '')", 45000)
    check('the signed-in side, after a round: "… isn’t signed in, so this 1v1 isn’t rated"', ok, card(bb))
    bb.screenshot(path=f'{SHOTS}/{BROWSER}-card-unlinked.png')
    check('gail\'s rating did not move', (dbget(f"ratings/{ub}") or {}).get('n') == 1)

    check('nothing reached the real Firebase', not blocked, blocked[:5])
    b.close()

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
