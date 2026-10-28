"""Relay keyboard regression checks. Serve locally, then run:

python tools/verify-relay.py http://127.0.0.1:5193 [chromium|firefox]
Requires Python Playwright. Uses a fresh profile and blocks hosted services.
"""
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5193'
assert re.fullmatch(r'http://(localhost|127\.0\.0\.1):\d+', BASE), 'Local QA only'
BROWSER = sys.argv[2] if len(sys.argv) > 2 else 'chromium'

with sync_playwright() as p:
    browser = getattr(p, BROWSER).launch()
    context = browser.new_context(service_workers='block')
    context.route(re.compile(r'https://'), lambda route: route.abort())
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda err: errors.append(str(err)))
    page.goto(BASE)
    page.wait_for_function('window.tagdatimer?.scramble?.scramble', timeout=90000)
    page.evaluate("""() => {
      tagdatimer.setSetting('inspection', false);
      tagdatimer.setSetting('holdTime', 0);
      tagdatimer.setSetting('misfireMs', 0);
      tagdatimer.setSetting('bgMode', 'solid');
    }""")
    ordinary = page.evaluate('tagdatimer.session.id')
    page.evaluate('tagdatimer.openRelayBuilder()')
    setting = page.get_by_role('checkbox', name='Press Space after every puzzle')
    expect(setting).not_to_be_checked()
    page.get_by_role('button', name='2\u00d73x3', exact=True).click()
    expect(setting).not_to_be_checked()
    page.get_by_role('button', name=re.compile('New session')).click()
    page.wait_for_function('tagdatimer.scramble?.parts?.length === 2', timeout=90000)

    def start():
        page.evaluate('document.activeElement?.blur()')
        page.keyboard.press('Space')
        page.wait_for_function("document.body.classList.contains('timing')")
        page.wait_for_timeout(650)

    start()
    expect(page.locator('#relay-now')).to_contain_text('press Space once')
    page.keyboard.press('Space')
    page.wait_for_function('tagdatimer.solves.length === 1')
    solve = page.evaluate('tagdatimer.solves.at(-1)')
    assert solve['timeMs'] >= 600
    assert [leg['event'] for leg in solve['relay']] == ['333', '333']
    assert all(leg['scramble'] and 'splitMs' not in leg for leg in solve['relay'])
    assert not solve.get('phases')
    assert page.evaluate("async () => (await import('/js/stats.js')).relaySummary(tagdatimer.solves)") is None
    print('PASS default: one stop saves total and all scrambles, without fabricated splits')

    page.wait_for_function('!document.body.classList.contains("timing")')
    page.evaluate('tagdatimer.openRelayBuilder()')
    setting.locator('..').click()
    expect(setting).to_be_checked()
    assert page.evaluate('tagdatimer.settings.relaySplitEach') is True
    page.wait_for_timeout(1200)
    page.reload()
    page.wait_for_function('window.tagdatimer?.scramble?.parts?.length === 2', timeout=90000)
    assert page.evaluate('tagdatimer.settings.relaySplitEach') is True
    assert page.evaluate('tagdatimer.solves.length') == 1
    print('PASS per-puzzle option and total-only solve persist after reload')

    start()
    page.keyboard.press('Space')
    assert page.evaluate('tagdatimer.solves.length') == 1
    expect(page.locator('#relay-now')).to_contain_text('2 of 2')
    page.wait_for_timeout(650)
    page.keyboard.press('Space')
    page.wait_for_function('tagdatimer.solves.length === 2')
    solve = page.evaluate('tagdatimer.solves.at(-1)')
    assert all(leg['splitMs'] >= 600 for leg in solve['relay'])
    assert abs(sum(leg['splitMs'] for leg in solve['relay']) - solve['timeMs']) < 0.001
    summary = page.evaluate("async () => (await import('/js/stats.js')).relaySummary(tagdatimer.solves)")
    assert summary['count'] == 1
    print('PASS optional per-puzzle presses: first splits, second saves the exact total')

    page.evaluate('tagdatimer.openRelayBuilder()')
    setting.locator('..').click()
    expect(setting).not_to_be_checked()
    page.wait_for_timeout(1200)
    page.reload()
    page.wait_for_function('window.tagdatimer?.scramble?.parts?.length === 2', timeout=90000)
    assert page.evaluate('tagdatimer.settings.relaySplitEach') is False
    start()
    page.keyboard.press('Space')
    page.wait_for_function('tagdatimer.solves.length === 3')
    assert page.evaluate('tagdatimer.solves.at(-1).relay.every(p => p.splitMs === undefined)')
    print('PASS switching back to single stop persists and works in a session with existing splits')

    with page.expect_download() as download_info:
        page.evaluate('tagdatimer.exportSessionCSV()')
    csv = Path(download_info.value.path()).read_text(encoding='utf-8')
    assert 'NaN' not in csv and 'undefined' not in csv
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_function("document.body.classList.contains('ph')")
    page.evaluate("async () => (await import('/js/phoneshell.js')).openSolveSheet(tagdatimer.solves.at(-1))")
    expect(page.locator('.ph-sv .rl-head i')).to_have_text(['\u2014', '\u2014'])
    page.evaluate("async () => (await import('/js/sheet.js')).closeAllSheets()")
    page.set_viewport_size({'width': 1280, 'height': 800})
    print('PASS CSV has no invalid numbers and phone solve details show unmeasured splits as dashes')

    page.evaluate('(id) => tagdatimer.switchSession(id)', ordinary)
    page.wait_for_function('tagdatimer.scramble && !tagdatimer.scramble.parts', timeout=90000)
    start()
    page.keyboard.press('Space')
    page.wait_for_function('tagdatimer.solves.length === 1')
    assert page.evaluate('!tagdatimer.solves[0].relay')
    print('PASS ordinary event still records with one stop')
    assert not errors, errors
    browser.close()

