# Inspection setting investigation

Investigated and fixed 6 October 2026 against the local working tree based on `1fc8f55`, using disposable Playwright profiles in Chromium and Firefox. No production account or user data was used. The original findings below describe the behavior before the fix.

## Fix and verification

Inspection now records a revision only when explicitly toggled or reset. Local saves atomically merge with the stored settings and preserve the latest inspection choice, so an unrelated save from an older tab cannot enable it. Incoming account settings use the same policy: stale choices are ignored and newer explicit choices still sync.

Toggles write immediately instead of waiting for the settings debounce. A small synchronous recovery record preserves an interrupted inspection write across reload and is cleared after the database commit succeeds. Defaults reset still intentionally enables inspection. The app cache version was bumped to 106 for pickup of these changes on the next deployment.

`tools/verify-inspection-report.cjs` now asserts the corrected behavior. Both Chromium and Firefox passed:

- Settings switch and 10 keyboard start/stop cycles per engine; event, mode, session, focus and unrelated-setting changes.
- The original stale-tab reproduction, including retaining the unrelated theme change and allowing a deliberate later enable.
- Five immediate reloads per engine, with zero lost inspection choices.
- Recovery after an intentionally aborted IndexedDB transaction.
- Ignoring older/unversioned remote inspection while accepting a newer remote choice.
- Rapid consecutive toggles, the `I` shortcut, and deliberate default-settings reset, including a synced device clock one minute ahead.

The data-health integration checks also passed, including the simulated cloud SDK, acknowledgement/retry/sign-out, database quota failure and manual timing. Its browser suites reported 476 self-tests and 56 sync checks passed.

The complete 476 self-tests and 56 sync checks passed independently in both Chromium and Firefox. `tools/verify-inspection-sync.mjs` also passed using the actual sync listener with a simulated Firebase SDK: a stale incoming choice queued only the two inspection correction fields, and a newer remote choice reached the timer without an upload loop.

## Finding

Inspection can come back after being explicitly disabled. A reproducible cause is an older tab overwriting the entire saved settings object when an unrelated setting changes. This reproduced in both browser engines. Ordinary timing did not spontaneously enable inspection.

## Reproduce the confirmed bug

1. Open the timer in two tabs with WCA inspection enabled.
2. Disable inspection in tab A and allow its database write to complete.
3. Leave tab B open with its older in-memory settings. Change its theme, and allow that write to complete.
4. Reload tab A. Inspection is enabled again.

`app.setSetting()` changes one field but saves the complete in-memory settings object (`js/main.js:5101`, `js/theme.js:309`). Tab B therefore saves its old `inspection: true` along with its new theme. The IndexedDB write hooks are scoped to the current page (`js/db.js:193`); tab B does not adopt tab A's change. On reload, tab A loads the overwritten database value (`js/theme.js:290`).

## Other paths checked

| Check | Result |
| --- | --- |
| Disable inspection through the Settings switch, then perform 10 keyboard start/stop cycles per browser | Inspection stayed off; each start went directly to timing |
| Switch between 2x2, 3x3, 3BLD and 4BLD | Stayed off |
| Switch OLL/WCA modes, create/switch sessions | Stayed off |
| Dispatch blur/focus, change an unrelated setting in the same tab, reload after the save completed | Stayed off |
| Press plain `I` while idle | Enabled inspection, as the documented shortcut specifies (`js/main.js:6381`) |
| Simulate incoming account settings with `inspection: true` through the actual merge and local write functions | Overwrites local `false`; the next Space press starts inspection |
| Disable inspection and immediately reload, three attempts in the final completed run per engine | Lost the setting in Chromium 1/3 and Firefox 3/3 |

The incoming account-settings check calls `mergeSettings()` and `KV.set()` directly. It verifies the merge and live adoption behavior, but does **not** establish that the reporting user's account received stale data. Remote values take precedence (`js/sync.js:509`), and the app applies incoming writes to the live timer (`js/main.js:4441`, `js/main.js:5122`).

In the final completed runs, disabling inspection and immediately reloading lost the setting in **Chromium 1/3 and Firefox 3/3 attempts**; an earlier Chromium run lost it in 0/3. `saveSettings()` waits 220 ms before writing. A reload that interrupts that pending save can restore the older enabled value. These small samples demonstrate reproduction, not an estimated frequency for users. This is timing-sensitive and is another reproduced way to encounter the reported symptom.

## Reproduction script

`tools/verify-inspection-report.cjs` runs the regression checks in isolated profiles. Start `python serve.py 5197 --no-browser`, then run `node tools/verify-inspection-report.cjs http://localhost:5197` with Playwright available, or set `TAGDA_PLAYWRIGHT_PATH` to its package directory.

## Assessment

The original report was credible: the settings overwrite and interrupted-save bugs were reproduced and are now fixed locally. The user's exact original trigger remains unverified. The intentional `I` shortcut remains available.

Some runs in both engines logged a page error about an undefined `facelets` property during event-switch checks. Inspection remained disabled through those checks; the preview error has not been diagnosed by this investigation. The latest Chromium run had no page errors.
