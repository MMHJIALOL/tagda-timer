"""The phone's Times tab as the desktop's panels, in real browsers.

    python -I tools/verify-phone-times.py <base url> [chromium|firefox] [shots dir]

A 390x844 touch phone with 14 seeded solves (one +2, one DNF). Checks the
STATS panel against the desktop's own figures, the TREND lines, the TIMES
panel as glass with the desktop's columns and colours, the background veil,
swiping a row left for +2, DNF and delete, the teal edge on the solve last
opened, the solve sheet's actions (Cross + 1 among them, Delete on its own
row) and Fewest Moves' cells. Live Firebase is blocked.
"""
import os, re, sys, tempfile
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else 'http://127.0.0.1:5173'
BROWSER = sys.argv[2] if len(sys.argv) > 2 else 'chromium'
SHOTS = sys.argv[3] if len(sys.argv) > 3 else os.path.join(tempfile.gettempdir(), 'phone-times-shots')
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
              if (type === 'pointerdown') { window.__f = document.elementFromPoint(x, y); window.__moved = 0; window.__x0 = x; }
              if (type === 'pointermove') window.__moved = Math.max(window.__moved, Math.abs(x - window.__x0));
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


def color_of(page, var):
    return page.evaluate(f"() => {{ const n = document.createElement('i'); n.style.color = 'var({var})'; document.body.append(n); const c = getComputedStyle(n).color; n.remove(); return c; }}")


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
        if ((tagdatimer.scramble?.scramble && !/generating/.test(document.getElementById('scramble-text').textContent)) || performance.now() - t0 > 15000) res(); else setTimeout(go, 50); }; go(); });
      for (let i = 0; i < times.length; i++) { await idle(); await tagdatimer.recordSolve({ timeMs: times[i], penalty: i === 3 ? '+2' : i === 6 ? 'DNF' : 'none' }); } }""", TIMES)
    check('the seeded solves have their scrambles', page.evaluate("() => tagdatimer.solves.every(s => s.scramble)"))
    page.reload(); page.wait_for_function(ready); page.wait_for_timeout(1200)
    page.add_style_tag(content='.an-card, .an-dlg, .an-pill { display: none !important; }')
    page.evaluate("() => document.querySelectorAll('.toast, .coffee-nudge').forEach(n => n.remove())")
    send = touch(page)
    gold, acc2 = color_of(page, '--gold'), color_of(page, '--accent-2')

    page.evaluate("() => document.querySelector('.ph-tab[data-tab=\"times\"]').click()")
    page.wait_for_timeout(900)

    # ---- STATS ----
    cells = page.evaluate("""() => [...document.querySelectorAll('#ph-times .ph-scell')].map(c => ({
      k: c.querySelector('.ph-scell-k').textContent.trim().toLowerCase(), v: c.querySelector('.ph-scell-v').textContent.trim(),
      shown: getComputedStyle(c.querySelector('.ph-scell-k')).textTransform, color: getComputedStyle(c.querySelector('.ph-scell-v')).color }))""")
    check('STATS: six cells in the desktop order', [c['k'] for c in cells] == ['ao5', 'ao12', 'mo3', 'best', 'ao50', 'mean'], [c['k'] for c in cells])
    desk = page.evaluate("() => ['ao5', 'ao12', 'mo3', 'best', 'ao50', 'mean'].map(k => document.getElementById('s-' + k)?.textContent.trim())")
    check('STATS: the same figures the desktop panel shows', [c['v'] for c in cells] == desk, ([c['v'] for c in cells], desk))
    check('STATS: small-caps labels, BEST in gold, the rest not', all(c['shown'] == 'uppercase' for c in cells)
          and cells[3]['color'] == gold and all(c['color'] != gold for i, c in enumerate(cells) if i != 3), cells)
    head = page.evaluate("() => [...document.querySelectorAll('#ph-times .ph-stats .ph-ph span')].map(s => s.textContent.trim())")
    check('STATS: heading and the solve count', head and head[0].lower() == 'stats' and '14' in head[1], head)

    # ---- TREND ----
    tr = page.evaluate("() => ['dt-solves', 'dt-ao', 'dt-ao12', 'dt-pbline', 'dt-dnf'].map(c => document.querySelectorAll('#ph-times .ph-trend-svg .' + c).length)")
    check('TREND: the times, ao5, ao12, the PB line and the DNF mark', all(n >= 1 for n in tr), tr)
    check('TREND: no dots in the line version', page.evaluate("() => document.querySelectorAll('#ph-times .ph-trend-svg .dt-dot').length") == 0)

    # ---- the panels are glass over a veiled background ----
    gl = page.evaluate("""() => ['.ph-stats', '.ph-trend', '#panel-times'].map(s => { const c = getComputedStyle(document.querySelector(s));
      return { bf: c.backdropFilter || c.webkitBackdropFilter, bg: c.backgroundColor, border: c.borderTopWidth, x: document.querySelector(s).getBoundingClientRect().x, w: document.querySelector(s).getBoundingClientRect().width }; })""")
    check('the three panels have a fill and a 1px edge, and line up', all(g['bg'] not in ('rgba(0, 0, 0, 0)', 'transparent') and g['border'] == '1px' for g in gl)
          and len({round(g['x']) for g in gl}) == 1 and len({round(g['w']) for g in gl}) == 1, gl)
    if BROWSER == 'chromium':
        check('...and a backdrop blur (Chrome)', all('blur' in (g['bf'] or '') for g in gl), [g['bf'] for g in gl])
    veil = page.evaluate("() => getComputedStyle(document.getElementById('ph-times')).backgroundColor")
    alpha = float(re.findall(r'[\d.]+', veil)[-1]) if veil.count(',') == 3 or ' / ' in veil else 1.0
    check('the tab is a veil the background shows through, not a solid fill', 0 < alpha < 0.9, veil)
    check('the timer under it is put away', page.evaluate("() => ['topbar', 'scramble-zone', 'timer-zone', 'ph-recent'].every(id => getComputedStyle(document.getElementById(id)).visibility === 'hidden')"))

    # ---- TIMES · 3X3 ----
    ph = page.evaluate("() => { const h = document.querySelector('#panel-times > .panel-head'); return h && h.getBoundingClientRect().height ? h.textContent.replace(/\\s+/g, ' ').trim() : null; }")
    check('TIMES: the desktop heading, with the event and the count', bool(ph) and '3x3' in ph.lower() and '14' in ph, ph)
    cols = page.evaluate("() => [...document.querySelectorAll('#panel-times .hist-cols > *')].filter(n => n.getBoundingClientRect().width).map(n => (getComputedStyle(n, '::before').content.replace(/\"/g, '').replace(/^none$/, '') + n.textContent).replace(/[\\s✎]+/g, ' ').trim().toLowerCase())")
    check('TIMES: columns #, time, ao5, ao12', [c for c in cols if c] == ['#', 'time', 'ao5', 'ao12'], cols)
    rows = page.evaluate("""() => [...document.querySelectorAll('#hist-list .solve-chip')].map(r => ({ id: r.dataset.id, cls: r.className,
      t: r.querySelector('.t').textContent.trim(), tw: getComputedStyle(r.querySelector('.t')).fontWeight, ff: getComputedStyle(r).fontFamily,
      best: [...r.querySelectorAll('.avg.best')].map(a => getComputedStyle(a).color), h: r.getBoundingClientRect().height }))""")
    check('TIMES: a row per solve, newest first, every row carrying its solve id', len(rows) == 14 and all(r['id'] for r in rows)
          and rows[0]['id'] == page.evaluate("() => tagdatimer.solves.at(-1).id"), len(rows))
    check('TIMES: times in mono 700', all(r['tw'] in ('700', 'bold') and 'Mono' in r['ff'] for r in rows), rows[0])
    check('TIMES: the best averages wear gold badges', sum(len(r['best']) for r in rows) >= 2 and all(c == gold for r in rows for c in r['best']), [r['best'] for r in rows])
    check('TIMES: the best single row is the desktop gold, the DNF struck through',
          any('pb' in r['cls'] for r in rows) and page.evaluate("() => getComputedStyle(document.querySelector('#hist-list .solve-chip.dnf .t')).textDecorationLine") == 'line-through')

    # ---- swipe a row left ----
    def row_box(i): return page.evaluate(f"() => {{ const r = document.querySelectorAll('#hist-list .solve-chip')[{i}].getBoundingClientRect(); return {{ x: r.x, y: r.y, w: r.width, h: r.height }}; }}")

    def swipe_row(i, dx=-150):
        bb = row_box(i); x, y = bb['x'] + bb['w'] * .7, bb['y'] + bb['h'] / 2
        send('down', x, y)
        for k in range(1, 7): send('move', x + dx * k / 6, y + 2); page.wait_for_timeout(12)
        send('up', x + dx, y + 2); page.wait_for_timeout(350)

    rid = rows[2]['id']
    swipe_row(2)
    st = page.evaluate("""(id) => { const r = document.querySelector(`#hist-list .solve-chip[data-id="${id}"]`); const a = document.querySelector('.ph-row-acts');
      return { tr: r.style.translate, acts: !a.hidden && a.getBoundingClientRect().width, top: a.getBoundingClientRect().top, rtop: r.getBoundingClientRect().top,
               sheet: !!document.querySelector('.sheet.ph-sv') }; }""", rid)
    check('a row swiped left opens over +2, DNF and delete', st['tr'].startswith('-186') and st['acts'] and abs(st['top'] - st['rtop']) < 2 and not st['sheet'], st)
    page.screenshot(path=os.path.join(SHOTS, f'{BROWSER}-row-swipe.png'))
    page.locator('.ph-ract.plus2').click(); page.wait_for_timeout(400)
    check('...+2 lands on that solve', page.evaluate("(id) => tagdatimer.solves.find(s => s.id === id).penalty", rid) == '+2')
    swipe_row(2)
    page.locator('.ph-ract.dnf').click(); page.wait_for_timeout(400)
    check('...DNF lands on that solve', page.evaluate("(id) => tagdatimer.solves.find(s => s.id === id).penalty", rid) == 'DNF')
    swipe_row(2)
    page.locator('.ph-ract.dnf').click(); page.wait_for_timeout(400)
    check('...and DNF again clears it, as the pills do', page.evaluate("(id) => tagdatimer.solves.find(s => s.id === id).penalty", rid) == 'none')
    swipe_row(2)
    page.locator('.ph-ract.del').click(); page.wait_for_timeout(500)
    check('...delete removes that solve', page.evaluate("(id) => !tagdatimer.solves.some(s => s.id === id)", rid) and page.evaluate("() => tagdatimer.solves.length") == 13)
    undo = page.locator('.toast button', has_text=re.compile('undo', re.I))
    check('...with Undo', undo.count() > 0)
    if undo.count(): undo.first.click(); page.wait_for_function("() => tagdatimer.solves.length === 14")
    page.evaluate("() => document.querySelectorAll('.toast').forEach(n => n.remove())")
    page.wait_for_timeout(300)
    swipe_row(1, dx=-40)
    check('a short swipe springs back and opens nothing', page.evaluate("() => !document.querySelectorAll('#hist-list .solve-chip')[1].style.translate && !document.querySelector('.sheet.ph-sv')"))
    swipe_row(1)
    bb = row_box(4); send('down', bb['x'] + 40, bb['y'] + bb['h'] / 2); page.wait_for_timeout(40); send('up', bb['x'] + 40, bb['y'] + bb['h'] / 2); page.wait_for_timeout(400)
    check('a tap on another row closes the open one, and is not a tap on that row', page.evaluate("() => !document.querySelectorAll('#hist-list .solve-chip')[1].style.translate && !document.querySelector('.sheet.ph-sv')"))

    # ---- the solve sheet ----
    rid = page.evaluate("() => document.querySelectorAll('#hist-list .solve-chip')[3].dataset.id")
    bb = row_box(3); send('down', bb['x'] + 60, bb['y'] + bb['h'] / 2); page.wait_for_timeout(40); send('up', bb['x'] + 60, bb['y'] + bb['h'] / 2)
    page.wait_for_selector('.sheet.ph-sv', timeout=5000); page.wait_for_timeout(500)
    sh = page.evaluate("""() => { const s = document.querySelector('.sheet.ph-sv'); const g = s.querySelector('.ph-sv-grid'); const d = s.querySelector('.ph-sv-del');
      return { font: getComputedStyle(s).fontFamily, grid: [...g.children].map(b => b.textContent.trim()), gb: g.getBoundingClientRect().bottom,
               del: d && d.textContent.trim(), dt: d && d.getBoundingClientRect().top, dw: d && d.getBoundingClientRect().width, sw: s.querySelector('.sheet-body').clientWidth,
               scrW: getComputedStyle(s.querySelector('.ph-sv-scr p')).whiteSpace }; }""")
    check('the sheet is set in the interface face, its scramble wraps', 'Inter' in sh['font'] and sh['scrW'] != 'nowrap', sh)
    check('the sheet: Reconstruct, Cross + 1, Same scramble together', sh['grid'] == ['Reconstruct', 'Cross + 1', 'Same scramble'], sh['grid'])
    check('...and Delete on its own row below them, full width', sh['del'] == 'Delete solve' and sh['dt'] > sh['gb'] and sh['dw'] > sh['sw'] - 40, sh)
    page.screenshot(path=os.path.join(SHOTS, f'{BROWSER}-solve-sheet.png'))
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    if page.locator('.sheet.ph-sv').count():
        page.evaluate("() => document.querySelector('.sheet.ph-sv .ph-sv-close')?.click()"); page.wait_for_timeout(400)
    cur = page.evaluate("""(id) => { const r = document.querySelector(`#hist-list .solve-chip[data-id="${id}"]`);
      return { cls: r.className, sh: getComputedStyle(r).boxShadow, n: document.querySelectorAll('#hist-list .solve-chip.ph-cur').length }; }""", rid)
    check('the solve last opened keeps a teal edge, and only it', 'ph-cur' in cur['cls'] and cur['n'] == 1 and acc2.replace(' ', '') in cur['sh'].replace(' ', ''), cur)
    page.evaluate("async () => { const s = tagdatimer.solves.at(-1); s.penalty = '+2'; await tagdatimer.recordSolve({ timeMs: 15000 }); }")
    page.wait_for_timeout(600)
    check('...through a redraw of the list', page.evaluate("(id) => document.querySelector(`#hist-list .solve-chip[data-id=\"${id}\"]`)?.classList.contains('ph-cur')", rid))

    page.screenshot(path=os.path.join(SHOTS, f'{BROWSER}-times.png'))

    # ---- Fewest Moves ----
    page.evaluate("async () => { await tagdatimer.setEvent('333fm'); }")
    page.wait_for_timeout(1200)
    page.evaluate("() => document.querySelector('.ph-tab[data-tab=\"times\"]').click()"); page.wait_for_timeout(600)
    fk = page.evaluate("() => [...document.querySelectorAll('#ph-times .ph-scell-k')].map(k => k.textContent.trim().toLowerCase())")
    check('Fewest Moves: mo3 and the count first, the best mo3 in mo3’s place', fk == ['mo3', 'count', 'best mo3', 'best', 'ao50', 'mean'], fk)

    check('no page errors', not errors, errors[:3])
    known = [u for u in blocked if not re.search(r'/(config|announcements|changelog)\.json', u)]
    check('nothing reached a live Firebase host', not known, known[:3])
    b.close()


with sync_playwright() as p:
    run(p)
print(f'\n{passed} passed, {failed} failed  ({BROWSER}; shots in {SHOTS})')
sys.exit(1 if failed else 0)
