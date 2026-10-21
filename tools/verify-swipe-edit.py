"""Swipe to edit times on a phone (js/swipe-edit.js), in real browsers.

    python -I tools/verify-swipe-edit.py <base url> [chromium|firefox] [shots dir]

A 390x844 touch phone. Chrome gets real touches through CDP's
Input.dispatchTouchEvent; Firefox has no CDP, so it gets PointerEvents with
pointerType 'touch' dispatched where the finger would be. Does a solve, then
swipes the digits up, down, left and right, and checks that each edit landed
on the solve shown, that the timer never left idle, that a plain tap still
starts inspection or the solve (hold time counted from the finger), that the
scramble's own swipe still deals the next scramble, and that with the setting
off a press on the digits goes straight to the timer as it always did.

Serve the tree first (python serve.py <port> --no-browser). Every real
Firebase host is blocked (http and websocket) and the run fails if anything
tried to reach one other than the two known reads (config, announcements).
"""
import os, re, sys, tempfile
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else 'http://127.0.0.1:5173'
BROWSER = sys.argv[2] if len(sys.argv) > 2 else 'chromium'
SHOTS = sys.argv[3] if len(sys.argv) > 3 else os.path.join(tempfile.gettempdir(), 'swipe-edit-shots')
PROD = re.compile(r'(firebaseio\.com|firebasedatabase\.app|firebaseapp\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com)$')
os.makedirs(SHOTS, exist_ok=True)

passed = failed = 0
blocked = []


def check(name, cond, got=''):
    global passed, failed
    if cond: passed += 1
    else: failed += 1
    print(('ok    ' if cond else 'FAIL  ') + name + ('' if cond else f'   (got {str(got)[:240]})'), flush=True)


class Finger:
    """One finger on the glass: CDP touches in Chrome, touch PointerEvents elsewhere."""

    def __init__(self, page):
        self.page = page
        self.cdp = page.context.new_cdp_session(page) if BROWSER == 'chromium' else None

    def _cdp(self, kind, x, y):
        pts = [] if kind == 'touchEnd' else [{'x': x, 'y': y, 'id': 1}]
        self.cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': pts})

    def _ptr(self, kind, x, y):
        self.page.evaluate("""([kind, x, y]) => {
          if (kind === 'pointerdown') window.__fingerAt = document.elementFromPoint(x, y);
          const target = window.__fingerAt || document.body;
          target.dispatchEvent(new PointerEvent(kind, { bubbles: true, cancelable: true, composed: true,
            pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
            buttons: kind === 'pointerup' ? 0 : 1 }));
        }""", [kind, x, y])

    def down(self, x, y):
        self.x, self.y = x, y
        if self.cdp: self._cdp('touchStart', x, y)
        else: self._ptr('pointerdown', x, y)

    def move(self, x, y, steps=6):
        x0, y0 = self.x, self.y
        for i in range(1, steps + 1):
            xi, yi = x0 + (x - x0) * i / steps, y0 + (y - y0) * i / steps
            if self.cdp: self._cdp('touchMove', xi, yi)
            else: self._ptr('pointermove', xi, yi)
            self.page.wait_for_timeout(8)
        self.x, self.y = x, y

    def up(self):
        if self.cdp: self._cdp('touchEnd', self.x, self.y)
        else: self._ptr('pointerup', self.x, self.y)

    def tap(self, x, y, hold=40):
        self.down(x, y); self.page.wait_for_timeout(hold); self.up()

    def swipe(self, x, y, dx, dy):
        self.down(x, y)
        self.move(x + dx, y + dy)
        self.page.wait_for_timeout(30)
        self.up()


def guard(route):
    host = route.request.url.split('/')[2].split(':')[0]
    if PROD.search(host):
        blocked.append(route.request.url)
        return route.abort()
    return route.continue_()


def ws_guard(w):
    if PROD.search(w.url.split('/')[2].split(':')[0]):
        blocked.append(w.url); w.close()
    else:
        w.connect_to_server()


STATE = """() => ({
  display: [...document.getElementById('timer-display').classList].find(c => c.startsWith('state-')) || '',
  busy: ['inspecting', 'holding', 'armed', 'timing'].filter(c => document.body.classList.contains(c)),
  n: tagdatimer.solves.length,
  penalty: tagdatimer.solves.at(-1)?.penalty || null,
  id: tagdatimer.solves.at(-1)?.id || null,
  swiping: document.body.classList.contains('swiping'),
  scramble: document.getElementById('scramble-text').textContent.trim(),
})"""


def state(page): return page.evaluate(STATE)


def digits_centre(page):
    b = page.locator('#timer-display').bounding_box()
    return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2


def settle(page, ms=450):
    page.wait_for_timeout(ms)


def wait_idle(page, timeout=6000):
    page.wait_for_function("() => document.getElementById('timer-display').classList.contains('state-idle') && !document.body.classList.contains('timing')", timeout=timeout)


def set_settings(page, **kv):
    page.evaluate("async (kv) => { for (const [k, v] of Object.entries(kv)) await tagdatimer.setSetting(k, v); }", kv)
    page.wait_for_timeout(150)


def solve(page, f):
    """A real solve by touch, inspection off: tap to start, tap to stop."""
    x, y = digits_centre(page)
    before = state(page)['n']
    f.tap(x, y)
    page.wait_for_function("() => document.body.classList.contains('timing')", timeout=4000)
    page.wait_for_timeout(1100)
    f.tap(x, y)
    page.wait_for_function(f"() => tagdatimer.solves.length === {before + 1}", timeout=6000)
    wait_idle(page)
    settle(page, 700)   # the stray-tap grace after a stop, and the new-best toast


def run(p):
    launch = {'channel': 'chrome'} if BROWSER == 'chromium' else {}
    b = getattr(p, BROWSER).launch(**launch)
    opts = {'viewport': {'width': 390, 'height': 844}, 'has_touch': True, 'service_workers': 'block', 'device_scale_factor': 2}
    if BROWSER == 'chromium': opts['is_mobile'] = True
    ctx = b.new_context(**opts)
    ctx.route('**/*', guard)
    ctx.route_web_socket(re.compile('.*'), ws_guard)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(f'{BASE}/?emu=1')
    page.wait_for_function("() => window.tagdatimer && document.body.classList.contains('ph') && document.getElementById('scramble-text').textContent.trim().length > 5", timeout=30000)
    page.wait_for_timeout(800)
    f = Finger(page)
    set_settings(page, inspection=False, holdTime=0, swipeEdit=True, theme='nebula', confirmShortSolves=False)
    page.evaluate("() => document.querySelector('.coffee-nudge')?.remove()")

    # ---- a solve to edit ----
    solve(page, f)
    s0 = state(page)
    check('a touch solve is recorded and the timer is idle', s0['display'] == 'state-idle' and not s0['busy'], s0)
    x, y = digits_centre(page)

    # ---- the press is held back, then handed over ----
    f.down(x, y)
    page.wait_for_timeout(40)
    early = state(page)
    page.wait_for_timeout(200)
    late = state(page)
    f.up()
    page.wait_for_timeout(200)
    check('a still press on the digits is held back for a moment (nothing at 40 ms)', early['display'] == 'state-idle' and not early['busy'], early)
    check('...then handed to the timer, which arms it (hold time 0)', 'armed' in late['busy'] or late['display'] == 'state-ready', late)
    started = state(page)
    check('...and its release starts the solve', 'timing' in started['busy'], started)
    page.wait_for_timeout(900)
    f.tap(x, y)
    page.wait_for_function(f"() => tagdatimer.solves.length === {s0['n'] + 1}", timeout=6000)
    wait_idle(page); settle(page, 700)
    s1 = state(page)

    # ---- the four directions ----
    def swipe_check(name, dx, dy, want, shot=None, back=False):
        before = state(page)
        f.down(x, y)
        f.move(x + dx, y + dy)
        if back:
            page.wait_for_timeout(60)
            f.move(x + dx * .3, y + dy * .3)
        page.wait_for_timeout(60)
        mid = state(page)
        if shot:
            page.screenshot(path=os.path.join(SHOTS, f'{BROWSER}-{shot}.png'))
        f.up()
        settle(page)
        after = state(page)
        check(f'{name}: the timer never left idle', mid['display'] == 'state-idle' and not mid['busy'] and after['display'] == 'state-idle' and not after['busy'], (mid, after))
        check(f'{name}: the swipe shows while the finger is down, and goes on release', mid['swiping'] and not after['swiping'], (mid['swiping'], after['swiping']))
        ok = want(before, after)
        check(f'{name}: the edit landed on the shown solve', ok, (before, after))
        return mid, after

    mid, _ = swipe_check('up', 0, -110, lambda a, b: b['id'] == a['id'] and b['penalty'] == '+2', shot='swipe-up')
    lbl = page.evaluate("() => { const n = document.querySelector('.ph-sw-dir[data-dir=up]'); return n && getComputedStyle(n).color; }")
    swipe_check('up again (toggles the +2 off)', 0, -110, lambda a, b: b['id'] == a['id'] and b['penalty'] == 'none')
    swipe_check('down', 0, 110, lambda a, b: b['id'] == a['id'] and b['penalty'] == 'DNF', shot='swipe-down')
    swipe_check('right', 110, 0, lambda a, b: b['id'] == a['id'] and b['penalty'] == 'none', shot='swipe-right')
    swipe_check('short (under 56 px)', 0, -40, lambda a, b: b == a)
    swipe_check('diagonal (no clear axis)', 80, -80, lambda a, b: b == a)
    swipe_check('out to +2 and back to the middle', 0, -110, lambda a, b: b == a, back=True)
    page.wait_for_timeout(700)   # the delete cooldown is per action; leave room after any earlier one
    _, gone = swipe_check('left', -110, 0, lambda a, b: b['n'] == a['n'] - 1, shot='swipe-left')
    undo = page.locator('.toast button', has_text=re.compile('undo', re.I))
    check('a swipe delete offers Undo', undo.count() > 0, page.evaluate("() => document.getElementById('toasts').textContent"))
    if undo.count():
        undo.first.click()
        page.wait_for_function(f"() => tagdatimer.solves.length === {gone['n'] + 1}", timeout=4000)
        settle(page)

    # ---- the overlay is drawn where the digits are ----
    f.down(x, y); f.move(x, y - 100)
    page.wait_for_timeout(60)
    boxes = page.evaluate("""() => {
      const r = s => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { x: b.x, y: b.y, w: b.width, h: b.height }; };
      return { up: r('.ph-sw-dir[data-dir=up]'), down: r('.ph-sw-dir[data-dir=down]'), left: r('.ph-sw-dir[data-dir=left]'),
               right: r('.ph-sw-dir[data-dir=right]'), digits: r('#timer-display'), hint: r('.ph-sw-hint'),
               hintText: document.querySelector('.ph-sw-hint')?.textContent, op: getComputedStyle(document.getElementById('ph-swipe')).opacity };
    }""")
    f.move(x, y); page.wait_for_timeout(40); f.up(); settle(page)
    d = boxes['digits']
    meet = lambda a, b: not (a['x'] + a['w'] <= b['x'] or b['x'] + b['w'] <= a['x'] or a['y'] + a['h'] <= b['y'] or b['y'] + b['h'] <= a['y'])
    check('the four labels are on screen, round the digits, and the dragged digits touch none of them',
          all(boxes[k] and boxes[k]['w'] > 0 for k in ('up', 'down', 'left', 'right'))
          and boxes['up']['y'] + boxes['up']['h'] <= d['y'] and boxes['down']['y'] >= d['y'] + d['h']
          and not any(meet(boxes[k], d) for k in ('up', 'down', 'left', 'right'))
          and boxes['right']['x'] + boxes['right']['w'] <= 390 and boxes['left']['x'] >= 0
          and boxes['hint']['y'] >= boxes['down']['y'] + boxes['down']['h'], boxes)
    check('the hint says what letting go will do', boxes['hintText'] in ('Let go to add +2', 'Let go to remove the +2'), boxes['hintText'])
    check('the picked label takes its colour', lbl and lbl != page.evaluate("() => getComputedStyle(document.querySelector('.ph-sw-dir[data-dir=down]')).color"), lbl)

    # ---- the scramble's own swipe ----
    sb = page.locator('#scramble-text').bounding_box()
    before = state(page)
    f.swipe(sb['x'] + sb['width'] * .75, sb['y'] + sb['height'] / 2, -140, 0)
    page.wait_for_timeout(600)
    after = state(page)
    check('a swipe on the scramble still deals the next scramble', after['scramble'] != before['scramble'] and after['n'] == before['n'] and after['penalty'] == before['penalty'], (before['scramble'][:30], after['scramble'][:30]))
    check('...and never touches the timer', after['display'] == 'state-idle' and not after['busy'], after)

    # ---- inspection on: a tap still starts inspection; a swipe still edits ----
    set_settings(page, inspection=True)
    x, y = digits_centre(page)
    f.tap(x, y)
    page.wait_for_timeout(250)
    ins = state(page)
    check('inspection on: a tap on the digits starts inspection', 'inspecting' in ins['busy'], ins)
    page.locator('#inspect-cancel').click() if page.locator('#inspect-cancel').is_visible() else page.keyboard.press('Escape')
    wait_idle(page); settle(page)
    x, y = digits_centre(page)
    swipe_check('inspection on: up', 0, -110, lambda a, b: b['id'] == a['id'] and b['penalty'] == '+2')
    swipe_check('inspection on: right', 110, 0, lambda a, b: b['id'] == a['id'] and b['penalty'] == 'none')
    f.down(x, y); page.wait_for_timeout(300)
    held = state(page); f.up(); page.wait_for_timeout(200)
    check('inspection on: a held press starts inspection once it is handed over', 'inspecting' in held['busy'], held)
    page.locator('#inspect-cancel').click() if page.locator('#inspect-cancel').is_visible() else page.keyboard.press('Escape')
    wait_idle(page); settle(page)

    # ---- hold time 300 ms: counted from when the finger landed ----
    set_settings(page, inspection=False, holdTime=300)
    x, y = digits_centre(page)
    f.down(x, y); page.wait_for_timeout(200)
    short = state(page); f.up(); page.wait_for_timeout(200)
    check('hold 300: let go at 200 ms and nothing starts', 'timing' not in state(page)['busy'] and 'armed' not in short['busy'], (short, state(page)))
    wait_idle(page); settle(page)
    f.down(x, y); page.wait_for_timeout(370)
    long_ = state(page)
    f.up(); page.wait_for_timeout(150)
    ran = state(page)
    check('hold 300: armed at 370 ms after landing (the held-back 120 ms is not added)', 'armed' in long_['busy'] or long_['display'] == 'state-ready', long_)
    check('hold 300: ...and the release starts the solve', 'timing' in ran['busy'], ran)
    page.wait_for_timeout(900)
    f.tap(x, y)
    page.wait_for_function("() => !document.body.classList.contains('timing')", timeout=4000)
    wait_idle(page); settle(page, 700)
    swipe_check('hold 300: down', 0, 110, lambda a, b: b['id'] == a['id'] and b['penalty'] == 'DNF')

    # ---- setting off: a press goes straight to the timer, as it always did ----
    set_settings(page, holdTime=0, swipeEdit=False)
    x, y = digits_centre(page)
    before = state(page)
    f.down(x, y); page.wait_for_timeout(30)
    at30 = state(page)
    f.move(x, y - 110)
    f.up(); page.wait_for_timeout(250)
    off = state(page)
    check('setting off: the press arms the timer at once', 'armed' in at30['busy'] or at30['display'] == 'state-ready', at30)
    check('setting off: what was a swipe is a press and release, so the solve starts', 'timing' in off['busy'] and not off['swiping'], off)
    check('setting off: and no edit happened', off['penalty'] == before['penalty'], (before, off))
    page.wait_for_timeout(900)
    f.tap(x, y)
    page.wait_for_function(f"() => tagdatimer.solves.length === {before['n'] + 1}", timeout=6000)
    wait_idle(page); settle(page, 700)
    check('setting off: the overlay was never built', page.evaluate("() => !document.getElementById('ph-swipe') || getComputedStyle(document.getElementById('ph-swipe')).visibility === 'hidden'"))

    # ---- the setting's row: phones only ----
    set_settings(page, swipeEdit=True)
    page.evaluate("() => document.getElementById('btn-settings').click()")
    page.wait_for_selector('#drawer:not([hidden])')
    page.wait_for_timeout(300)
    row = page.locator('#drawer .row', has_text='Swipe to edit times')
    check('Settings has the Swipe to edit times row on a phone', row.count() == 1 and row.first.is_visible())
    if row.count():
        row.first.scroll_into_view_if_needed()
        page.screenshot(path=os.path.join(SHOTS, f'{BROWSER}-settings-row.png'))
    page.set_viewport_size({'width': 1024, 'height': 768})
    page.wait_for_timeout(500)
    check('...and not once the screen is a tablet (Settings rebuilt while open)', page.locator('#drawer .row', has_text='Swipe to edit times').count() == 0 and not page.locator('#drawer').is_hidden())
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_timeout(500)
    check('...and back on a phone', page.locator('#drawer .row', has_text='Swipe to edit times').count() == 1)
    search = page.locator('#drawer .settings-search-input')
    search.fill('cstimer swipe')
    page.wait_for_timeout(200)
    check('settings search finds it by its aliases', page.locator('#drawer .row:not(.settings-search-hidden)', has_text='Swipe to edit times').count() == 1)
    toggle_ = page.locator('#drawer .row', has_text='Swipe to edit times').locator('.switch')
    toggle_.click()
    page.wait_for_timeout(200)
    check('the toggle writes swipeEdit', page.evaluate("() => tagdatimer.settings.swipeEdit") is False)
    toggle_.click()
    page.wait_for_timeout(200)
    page.evaluate("() => document.getElementById('drawer-close').click()")

    # ---- Paper, mid-swipe ----
    set_settings(page, theme='paper')
    page.wait_for_timeout(500)
    x, y = digits_centre(page)
    f.down(x, y); f.move(x, y + 100); page.wait_for_timeout(60)
    page.screenshot(path=os.path.join(SHOTS, f'{BROWSER}-swipe-down-paper.png'))
    f.move(x, y); page.wait_for_timeout(30); f.up(); settle(page)
    set_settings(page, theme='nebula')

    check('no page errors', not errors, errors[:3])
    known = [u for u in blocked if not re.search(r'/(config|announcements)\.json', u)]
    check('nothing reached a live Firebase host', not known, known[:3])
    b.close()


with sync_playwright() as p:
    run(p)
print(f'\n{passed} passed, {failed} failed  ({BROWSER}; shots in {SHOTS})')
sys.exit(1 if failed else 0)
