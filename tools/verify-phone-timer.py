"""The phone's timer screen and its Classic switch, in real browsers.

    python -I tools/verify-phone-timer.py <base url> [chromium|firefox] [shots dir]

A 390x844 touch phone with 14 seeded solves. Checks the post-solve row (order,
sizes, the 44px hit areas, Delete with Undo, Cross + 1 on the solve's own
scramble), the icon dock, the preview tile and its sheet, that the tile goes
in focus states, a 7x7's six-line scramble with "all N moves", and Appearance ›
Phone layout › Classic: the website's own layout on a phone, timing and
swipe-to-edit still working, and back again. Live Firebase is blocked.
"""
import os, re, sys, tempfile
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else 'http://127.0.0.1:5173'
BROWSER = sys.argv[2] if len(sys.argv) > 2 else 'chromium'
SHOTS = sys.argv[3] if len(sys.argv) > 3 else os.path.join(tempfile.gettempdir(), 'phone-timer-shots')
PROD = re.compile(r'(firebaseio\.com|firebasedatabase\.app|firebaseapp\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com)$')
TIMES = [12460, 11300, 13180, 12920, 10530, 11340, 14020, 12110, 13820, 11870, 12650, 11990, 12300, 11300]
os.makedirs(SHOTS, exist_ok=True)
passed = failed = 0
blocked = []


def check(name, cond, got=''):
    global passed, failed
    if cond: passed += 1
    else: failed += 1
    print(('ok    ' if cond else 'FAIL  ') + name + ('' if cond else f'   (got {str(got)[:300]})'), flush=True)


def touch(page):
    cdp = page.context.new_cdp_session(page) if BROWSER == 'chromium' else None

    def send(kind, x, y):
        if cdp:
            t = {'down': 'touchStart', 'move': 'touchMove', 'up': 'touchEnd'}[kind]
            cdp.send('Input.dispatchTouchEvent', {'type': t, 'touchPoints': [] if t == 'touchEnd' else [{'x': x, 'y': y, 'id': 1}]})
        else:
            page.evaluate("""([kind, x, y]) => {
              const type = { down: 'pointerdown', move: 'pointermove', up: 'pointerup' }[kind];
              if (type === 'pointerdown') window.__f = document.elementFromPoint(x, y);
              (window.__f || document.body).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
                pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
              if (type === 'pointerup' && window.__f) window.__f.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            }""", [kind, x, y])
    return send


def guard(route):
    if PROD.search(route.request.url.split('/')[2].split(':')[0]):
        blocked.append(route.request.url); return route.abort()
    return route.continue_()


def ws(w):
    if PROD.search(w.url.split('/')[2].split(':')[0]): blocked.append(w.url); w.close()
    else: w.connect_to_server()


BOX = "s => { const n = document.querySelector(s); const r = n?.getBoundingClientRect(); return r && r.width ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }"


def box(page, sel): return page.evaluate(f"({BOX})({sel!r})")


def visible(page, sel):
    b = box(page, sel)
    return bool(b) and page.evaluate(f"(s => {{ const n = document.querySelector(s); const c = getComputedStyle(n); return c.visibility !== 'hidden' && +c.opacity > 0.05; }})({sel!r})")


def hit(page, x, y): return page.evaluate("([x, y]) => { const n = document.elementFromPoint(x, y); return n && (n.closest('button')?.className || n.id || n.tagName); }", [x, y])


def run(p):
    b = getattr(p, BROWSER).launch(**({'channel': 'chrome'} if BROWSER == 'chromium' else {}))
    opts = {'viewport': {'width': 390, 'height': 844}, 'has_touch': True, 'service_workers': 'block', 'device_scale_factor': 2}
    if BROWSER == 'chromium': opts['is_mobile'] = True
    ctx = b.new_context(**opts)
    ctx.route('**/*', guard); ctx.route_web_socket(re.compile('.*'), ws)
    page = ctx.new_page(); page.set_default_timeout(40000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    ready = "() => window.tagdatimer && document.body.dataset.input && !/generating/.test(document.getElementById('scramble-text').textContent) && document.getElementById('scramble-text').textContent.trim().length > 5"
    page.goto(f'{BASE}/?emu=1'); page.wait_for_function(ready)
    page.evaluate("async () => { for (const [k, v] of Object.entries({ inspection: false, confirmShortSolves: false, theme: 'nebula' })) await tagdatimer.setSetting(k, v); }")
    page.evaluate("""async (times) => {
          const idle = () => new Promise(res => { const t0 = performance.now(); const go = () => {
            const x = document.getElementById('scramble-text').textContent;
            if ((tagdatimer.scramble?.scramble && !/generating/.test(x)) || performance.now() - t0 > 15000) res(); else setTimeout(go, 50); }; go(); });
          for (let i = 0; i < times.length; i++) {
            await idle();
            await tagdatimer.recordSolve({ timeMs: times[i], });
          }
        }""", TIMES)
    page.reload(); page.wait_for_function(ready); page.wait_for_timeout(1500)
    check('the seeded solves have their scrambles', page.evaluate("() => tagdatimer.solves.every(s => s.scramble)"))
    page.add_style_tag(content='.an-card, .an-dlg, .an-pill { display: none !important; }')
    page.evaluate("() => document.querySelectorAll('.toast, .coffee-nudge').forEach(n => n.remove())")
    send = touch(page)

    def tap(sel):
        bb = box(page, sel); x, y = bb['x'] + bb['w'] / 2, bb['y'] + bb['h'] / 2
        send('down', x, y); page.wait_for_timeout(40); send('up', x, y); page.wait_for_timeout(250)

    # ---- the post-solve row ----
    order = ['[data-act="+2"]', '[data-act="DNF"]', '.ph-note-btn', '.ph-recon-btn', '.ph-xp1-btn', '[data-act="delete"]']
    boxes = [box(page, f'#last-actions {s}') for s in order]
    check('the row has +2, DNF, Note, Reconstruct, Cross + 1 and Delete, all on screen', all(boxes), boxes)
    if all(boxes):
        xs = [bb['x'] for bb in boxes]
        check('...in that order, left to right, on one line', xs == sorted(xs) and len({round(bb['y']) for bb in boxes}) == 1, xs)
        check('...each pill 32px tall', all(abs(bb['h'] - 32) < 1.5 for bb in boxes), [bb['h'] for bb in boxes])
        check('...the icon pills 36px wide', all(abs(bb['w'] - 36) < 1.5 for bb in boxes[2:]), [bb['w'] for bb in boxes[2:]])
        gap1 = boxes[2]['x'] - (boxes[1]['x'] + boxes[1]['w']); gap2 = boxes[5]['x'] - (boxes[4]['x'] + boxes[4]['w'])
        check('...with a wider gap before Note and before Delete', gap1 >= 10 and gap2 >= 10, (gap1, gap2))
        d = boxes[5]
        check('a pill takes a tap 6px above and below it (the 44px hit area)',
              'ph-del' in (hit(page, d['x'] + d['w'] / 2, d['y'] - 5) or '') and 'ph-del' in (hit(page, d['x'] + d['w'] / 2, d['y'] + d['h'] + 5) or ''),
              (hit(page, d['x'] + d['w'] / 2, d['y'] - 5), hit(page, d['x'] + d['w'] / 2, d['y'] + d['h'] + 5)))
    labels = page.evaluate("""() => [...document.querySelectorAll('#last-actions button')].filter(b => b.getBoundingClientRect().width)
      .map(b => [b.getAttribute('aria-label'), b.title])""")
    check('every pill has an aria-label and a title', labels and all(a and t for a, t in labels), labels)
    del_color = page.evaluate("() => getComputedStyle(document.querySelector('#last-actions [data-act=delete]')).color")
    danger = page.evaluate("() => { const n = document.createElement('i'); n.style.color = 'var(--danger)'; document.body.append(n); const c = getComputedStyle(n).color; n.remove(); return c; }")
    check('Delete is red', del_color == danger, (del_color, danger))

    n0 = page.evaluate("() => tagdatimer.solves.length")
    shown = page.evaluate("() => tagdatimer.solves.at(-1).id")
    tap('#last-actions [data-act="delete"]')
    check('Delete deletes the shown solve', page.evaluate("() => tagdatimer.solves.length") == n0 - 1
          and not page.evaluate("(id) => tagdatimer.solves.some(s => s.id === id)", shown), page.evaluate("() => tagdatimer.solves.length"))
    undo = page.locator('.toast button', has_text=re.compile('undo', re.I))
    check('...and offers Undo', undo.count() > 0)
    if undo.count():
        undo.first.click(); page.wait_for_function(f"() => tagdatimer.solves.length === {n0}")
    check('...which puts it back', page.evaluate("() => tagdatimer.solves.at(-1).id") == shown)
    page.evaluate("() => document.querySelectorAll('.toast').forEach(n => n.remove())")

    scr = page.evaluate("() => tagdatimer.solves.at(-1).scramble")
    tap('#last-actions .ph-xp1-btn')
    page.wait_for_function("() => document.body.classList.contains('xp1-open')", timeout=30000)
    page.wait_for_timeout(800)
    xtext = page.evaluate("() => document.getElementById('xp1').textContent.replace(/\\s+/g, ' ')")
    check('Cross + 1 opens on the shown solve’s own scramble', ' '.join(scr.split()) in xtext, (scr, xtext[:200]))
    page.evaluate("async () => (await import('./js/xplus1.js')).closeXp1()")
    page.wait_for_timeout(500)
    check('...and closes back to the timer', not page.evaluate("() => document.body.classList.contains('xp1-open')"))

    # ---- the dock ----
    dk = box(page, '#ph-dock')
    check('the dock is a 216x52 capsule, centred', dk and abs(dk['w'] - 216) < 2 and abs(dk['h'] - 52) < 2 and abs(dk['x'] + dk['w'] / 2 - 195) < 2, dk)
    tabs = page.evaluate("""() => [...document.querySelectorAll('.ph-tab')].map(t => ({ label: t.getAttribute('aria-label'), text: t.textContent.trim(),
      on: t.classList.contains('on'), bg: getComputedStyle(t).backgroundColor, dot: getComputedStyle(t, '::after').backgroundColor,
      dotShown: getComputedStyle(t, '::after').content !== 'none', color: getComputedStyle(t).color }))""")
    check('four icon tabs, each with a label and no words', len(tabs) == 4 and all(t['label'] and not t['text'] for t in tabs), tabs)
    acc2 = page.evaluate("() => { const n = document.createElement('i'); n.style.color = 'var(--accent-2)'; document.body.append(n); const c = getComputedStyle(n).color; n.remove(); return c; }")
    on = [t for t in tabs if t['on']]
    check('the tab you are on has a teal dot and no tinted pill', len(on) == 1 and on[0]['dotShown'] and on[0]['dot'] == acc2 and on[0]['bg'] in ('rgba(0, 0, 0, 0)', 'transparent'), on)
    check('the others are faint, with no dot', all(not t['dotShown'] and t['color'] != on[0]['color'] for t in tabs if not t['on']), tabs)
    rc = box(page, '#ph-recent')
    check('the recent strip clears the dock', rc and dk and rc['y'] + rc['h'] <= dk['y'] + 1, (rc, dk))

    # ---- the tile ----
    tl = box(page, '#ph-net')
    check('the preview tile is about 116x88, bottom right, above the recent strip',
          tl and abs(tl['w'] - 116) < 3 and abs(tl['h'] - 88) < 3 and tl['x'] + tl['w'] >= 390 - 18 and tl['y'] + tl['h'] < rc['y'], (tl, rc))
    sc = box(page, '#scramble-text')
    check('the scramble has the full width', sc and sc['w'] > 390 - 2 * 16 - 8, sc)
    acts = box(page, '#last-actions')
    check('nothing in the clock reaches the tile', acts['y'] + acts['h'] <= page.evaluate("() => document.getElementById('ph-tile').getBoundingClientRect().top"), (acts, tl))
    tap('.ph-tile-btn[data-view="3D"]')
    check('3D in the tile: saved, and pressed', page.evaluate("() => tagdatimer.settings.phPreview") == '3D'
          and page.evaluate("() => document.querySelector('.ph-tile-btn[data-view=\"3D\"]').getAttribute('aria-pressed')") == 'true')
    tap('.ph-tile-btn[data-view="2D"]')
    tap('#ph-net')
    page.wait_for_selector('.ph-cube-sheet', timeout=5000)
    page.wait_for_timeout(500)
    sh = box(page, '.ph-cube-sheet .ph-cube3d')
    check('tapping the tile opens the full-width preview', sh and sh['w'] > 330, sh)
    page.screenshot(path=os.path.join(SHOTS, f'{BROWSER}-preview-sheet.png'))
    page.keyboard.press('Escape'); page.wait_for_timeout(400)
    if page.locator('.ph-cube-sheet').count():
        page.evaluate("() => document.querySelector('.ph-cube-sheet .sheet-done')?.click()"); page.wait_for_timeout(400)

    # ---- focus: the tile goes with the rest ----
    page.evaluate("async () => { await tagdatimer.setSetting('holdTime', 300); }")
    db = box(page, '#timer-display'); x, y = db['x'] + db['w'] / 2, db['y'] + db['h'] / 2
    send('down', x, y); page.wait_for_timeout(500)
    op = page.evaluate("() => +getComputedStyle(document.getElementById('ph-tile')).opacity")
    armed = page.evaluate("() => document.body.classList.contains('armed') || document.body.classList.contains('holding')")
    send('up', x, y); page.wait_for_timeout(700)
    send('down', x, y); page.wait_for_timeout(40); send('up', x, y)
    page.wait_for_function("() => !document.body.classList.contains('timing')", timeout=4000)
    page.wait_for_timeout(700)
    page.evaluate("async () => { await tagdatimer.setSetting('holdTime', 0); }")
    check('holding the screen hides the tile with the rest of the chrome', armed and op < 0.05, (armed, op))

    # ---- a 7x7's scramble ----
    page.evaluate("async () => { await tagdatimer.setEvent('777'); }")
    page.wait_for_function("() => { const x = document.getElementById('scramble-text').textContent; return x.split(/\\s+/).length > 80 && !/generating/.test(x); }", timeout=90000)
    page.wait_for_timeout(600)
    lay = page.evaluate("""() => ({ cls: document.getElementById('scramble-zone').className, h: document.getElementById('scramble-text').getBoundingClientRect().height,
      lh: parseFloat(getComputedStyle(document.getElementById('scramble-text')).lineHeight), fs: getComputedStyle(document.getElementById('scramble-text')).fontSize,
      all: document.getElementById('ph-all-moves').hidden ? null : document.getElementById('ph-all-moves').textContent,
      zb: document.getElementById('scramble-zone').getBoundingClientRect().bottom, dt: document.getElementById('timer-display').getBoundingClientRect().top })""")
    check('7x7: 16px, held to six lines', lay['fs'] == '16px' and 'ph-capped' in lay['cls'] and lay['h'] <= 6 * lay['lh'] + 1, lay)
    check('7x7: "all 100 moves" beside the tools', bool(lay['all']) and '100' in lay['all'], lay['all'])
    check('7x7: the digits stay clear of the scramble', lay['dt'] > lay['zb'], lay)
    page.screenshot(path=os.path.join(SHOTS, f'{BROWSER}-777.png'))
    tap('#ph-all-moves')
    page.wait_for_selector('.ph-scr-sheet', timeout=5000)
    full = page.evaluate("() => document.querySelector('.ph-scr-sheet .ph-scr-all').textContent.trim().split(/\\s+/).length")
    check('"all 100 moves" opens the whole scramble in a sheet', full == 100, full)
    page.evaluate("() => document.querySelector('.ph-scr-sheet .sheet-done')?.click()"); page.wait_for_timeout(400)
    page.evaluate("async () => { await tagdatimer.setEvent('333'); }")
    page.wait_for_function("() => !/generating/.test(document.getElementById('scramble-text').textContent)")
    page.wait_for_timeout(500)

    # ---- Classic ----
    page.evaluate("() => document.getElementById('btn-theme').click()")
    page.wait_for_selector('#drawer:not([hidden])'); page.wait_for_timeout(300)
    row = page.locator('#drawer .row', has_text='Phone layout')
    check('Appearance › Layout has Phone layout on a phone', row.count() == 1)
    if row.count():
        row.first.scroll_into_view_if_needed()
        page.screenshot(path=os.path.join(SHOTS, f'{BROWSER}-appearance-row.png'))
        row.first.get_by_text('Classic', exact=True).click()
        page.wait_for_timeout(600)
    page.evaluate("() => document.getElementById('drawer-close').click()"); page.wait_for_timeout(600)
    st = page.evaluate("""() => ({ ph: document.body.classList.contains('ph'), setting: tagdatimer.settings.phoneLayout,
      dock: !!document.getElementById('ph-dock')?.getBoundingClientRect().width, tile: !!document.getElementById('ph-tile')?.getBoundingClientRect().width,
      brand: !!document.querySelector('.topbar-left')?.getBoundingClientRect().width, menu: !!document.getElementById('btn-menu')?.getBoundingClientRect().width,
      times: !!document.getElementById('panel-times')?.getBoundingClientRect().width })""")
    check('Classic: the phone shell is off (no dock, no tile)', not st['ph'] and st['setting'] == 'classic' and not st['dock'] and not st['tile'], st)
    check('Classic: the website’s top bar, menu and times panel are back', st['brand'] and st['menu'] and st['times'], st)
    page.screenshot(path=os.path.join(SHOTS, f'{BROWSER}-classic.png'))
    db = box(page, '#timer-display'); x, y = db['x'] + db['w'] / 2, db['y'] + db['h'] / 2
    n1 = page.evaluate("() => tagdatimer.solves.length")
    send('down', x, y); page.wait_for_timeout(40); send('up', x, y); page.wait_for_timeout(300)
    started = page.evaluate("() => document.body.classList.contains('timing')")
    page.wait_for_timeout(800)
    send('down', x, y); page.wait_for_timeout(40); send('up', x, y)
    page.wait_for_timeout(900)
    check('Classic: a tap on the digits starts the timer, another stops it', started and page.evaluate("() => tagdatimer.solves.length") == n1 + 1)
    page.wait_for_timeout(600)
    db = box(page, '#timer-display'); x, y = db['x'] + db['w'] / 2, db['y'] + db['h'] / 2
    send('down', x, y)
    for i in range(1, 7): send('move', x, y - 110 * i / 6); page.wait_for_timeout(10)
    page.wait_for_timeout(60); send('up', x, y - 110); page.wait_for_timeout(400)
    check('Classic: swipe up still adds +2', page.evaluate("() => tagdatimer.solves.at(-1).penalty") == '+2' and not page.evaluate("() => document.body.classList.contains('timing')"))
    page.evaluate("async () => { await tagdatimer.setSetting('phoneLayout', 'tagda'); }")
    page.wait_for_timeout(600)
    back = page.evaluate("() => ({ ph: document.body.classList.contains('ph'), dock: !!document.getElementById('ph-dock').getBoundingClientRect().width, tile: !!document.getElementById('ph-tile').getBoundingClientRect().width })")
    check('Tagda again: the shell comes back', back['ph'] and back['dock'] and back['tile'], back)
    page.wait_for_timeout(500)
    page.reload(); page.wait_for_function(ready); page.wait_for_timeout(500)
    check('...and stays chosen across a reload', page.evaluate("() => document.body.classList.contains('ph')"))
    page.evaluate("async () => { await tagdatimer.setSetting('phoneLayout', 'classic'); }")
    page.wait_for_timeout(500)   # settings are saved 220ms after the last change
    page.reload(); page.wait_for_function(ready); page.wait_for_timeout(500)
    check('Classic stays chosen across a reload', not page.evaluate("() => document.body.classList.contains('ph')"))
    page.evaluate("async () => { await tagdatimer.setSetting('phoneLayout', 'tagda'); }")

    page.set_viewport_size({'width': 1024, 'height': 768}); page.wait_for_timeout(400)
    page.evaluate("() => document.getElementById('btn-theme').click()"); page.wait_for_timeout(400)
    check('no Phone layout row on a tablet', page.locator('#drawer .row', has_text='Phone layout').count() == 0)

    check('no page errors', not errors, errors[:3])
    known = [u for u in blocked if not re.search(r'/(config|announcements|changelog)\.json', u)]
    check('nothing reached a live Firebase host', not known, known[:3])
    b.close()


with sync_playwright() as p:
    run(p)
print(f'\n{passed} passed, {failed} failed  ({BROWSER}; shots in {SHOTS})')
sys.exit(1 if failed else 0)
