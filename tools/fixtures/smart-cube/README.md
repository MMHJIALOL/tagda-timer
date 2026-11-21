# GAN hardware recordings

These fixtures contain decoded turn/state notifications and completed test
attempts from the owner's November 2026 Smart Cube Lab uploads:

| Fixture | Hardware / firmware | Original report |
| --- | --- | --- |
| `gan-i3x3s.json` | GANi3x3s / 7.76 | `aa089bbcde0b4912b92496547a57ce5b` |
| `gan-i3.json` | GANi30Mc / 7.76 | `edd06f5893ec41d7be5472a40287be54` |
| `gan-icarry-e.json` | GANicE2 / 2.9 | `589d85b5a767403a98cf5fb9b56b8764` |
| `gan-i4-1.json` | GANi4 / 1.12 | `044a102399a84f5b90dbfc1a5af1aba0` |
| `gan-i4-2.json` | GANi4 / 1.12 | `12e8b6d1519b4985916f6f2002671a6f` |
| `gan-i4-3.json` | GANi4 / 1.12 | `61282f9bfdde45199c33330d4e137cca` |

Browser identifiers, device suffixes, notes, wall-clock dates and unrelated lab
events are omitted. Receive times are shifted to the first state/turn event.
Clock differences, serial order, facelet strings and turn notation are preserved.
The fixtures remain usable after the original seven-day reports expire.

Each event is `["M", receiveMs, serial, turn, cubeMs, localMs]` or
`["S", receiveMs, serial, facelets]`. Each solve's moves are
`[serial, turn, cubeMs, localMs]`.
The i4 solve moves add a fifth field, receive time relative to the first
state/turn event, so recovered turns with null device/local clocks retain an
honest receive-clock fallback. The i4 `gyro` arrays contain dedicated-test
samples as `[receiveMs, x, y, z, w]`, preserving the original quaternions.

The three i4 recordings contain 842, 968 and 2,306 turns and 26 completed lab
attempts. They include recovered history arriving 2.004 seconds after its state
snapshot. All turns apply in order without discrepancies with the three-second
recovery deadline. The raw hardware flag says `gyroSupported: false` because
gan-web-bluetooth 3.0.2 omits the i4 from its Gen4 gyro model list; 379 preserved
orientation samples demonstrate rotation on all three axes. Actual valid samples
override that flag for the connection UI, while the raw evidence stays intact.

Both i3 traces apply all moves without state/sequence issues. The i carry E
trace delivers snapshots before their turns; these must not cause false gaps.
It also contains contradictory snapshots at serials 0 and 4. Those remain errors:
the implementation must not suppress them to make this fixture pass.

The very short i3 lab results are one- and two-turn exercises. A one-turn
first-to-last-turn interval is zero; this does not validate external timing
accuracy. These recordings exercise decoded events, not Bluetooth pairing or
the entire main-timer workflow on physical hardware.
