# GAN hardware recordings

These fixtures contain decoded turn/state notifications and completed test
attempts from the owner's November 2026 Smart Cube Lab uploads:

| Fixture | Hardware / firmware | Original report |
| --- | --- | --- |
| `gan-i3x3s.json` | GANi3x3s / 7.76 | `aa089bbcde0b4912b92496547a57ce5b` |
| `gan-i3.json` | GANi30Mc / 7.76 | `edd06f5893ec41d7be5472a40287be54` |
| `gan-icarry-e.json` | GANicE2 / 2.9 | `589d85b5a767403a98cf5fb9b56b8764` |

Browser identifiers, device suffixes, notes, wall-clock dates and unrelated lab
events are omitted. Receive times are shifted to the first state/turn event.
Clock differences, serial order, facelet strings and turn notation are preserved.
The fixtures remain usable after the original seven-day reports expire.

Each event is `["M", receiveMs, serial, turn, cubeMs, localMs]` or
`["S", receiveMs, serial, facelets]`. Each solve's moves are
`[serial, turn, cubeMs, localMs]`.

Both i3 traces apply all moves without state/sequence issues. The i carry E
trace delivers snapshots before their turns; these must not cause false gaps.
It also contains contradictory snapshots at serials 0 and 4. Those remain errors:
the implementation must not suppress them to make this fixture pass.

The very short i3 lab results are one- and two-turn exercises. A one-turn
first-to-last-turn interval is zero; this does not validate external timing
accuracy. These recordings exercise decoded events, not Bluetooth pairing or
the entire main-timer workflow on physical hardware.
