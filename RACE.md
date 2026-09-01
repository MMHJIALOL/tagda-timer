# Race mode

Everyone in a room gets the same scramble and attacks it whenever they are ready.
**Nobody's time is visible to you until you have finished that same scramble yourself** —
until then all you can see is that they are *done*, which is the whole feeling the mode
exists for.

It ships working. With no configuration at all it runs in **local mode** (other tabs of
your own browser), which is enough to develop against, demo, and test. Point it at a
Firebase project and the same feature works between real people on real machines.

---

## 1. The design decisions worth knowing

**It is not a synchronised 3‑2‑1‑go.** WCA inspection is a personal fifteen seconds and
network latency is real, so a shared countdown would be unfair in a way nobody could see.
Same scramble, same window, your own clock — the same model cstimer uses.

**Status is public; times are private.** A round stores those two things in separate
places:

```
rounds/<n>/progress/<uid>   who is ready / inspecting / solving / finished   ← anyone
rounds/<n>/results/<uid>    how fast they actually were                     ← gated
```

That split is the entire trick. It lets the panel show "3 of 5 finished" and a filling
pressure meter while telling you *nothing* about how fast any of them were.

**The reveal is enforced by the database, not by the UI.** A static site's Firebase config
is necessarily public, so anything the UI merely declines to render can still be read
straight off the wire with devtools open. The read rule on `results` is what makes the
guarantee real:

```
".read": "auth != null && data.child(auth.uid).exists()"
```

You may read the results collection only once *your own* result is in it.

**Results are write‑once.** Without that, the read gate above creates its own exploit:
submit a throwaway time to unlock the reveal, read everyone else's real times, then
rewrite your own to just beat the best one. `!data.exists()` closes it.

---

## 2. Anti‑cheat, honestly

No camera. No microphone. No screen recording. Ever. What there is:

### Enforced by database rules — Tier 1

| Rule | What it stops |
|---|---|
| `results` readable only once your own exists | Reading the room's times before you have earned them, including off the raw wire |
| `results/<uid>` write‑once | Submitting a decoy, peeking, then editing your time down |
| `hash` must equal the round's `info/hash` | Claiming a time against a different, easier scramble |
| `timeMs` checked against the server‑stamped solve window | Pausing the app and typing in a fabricated number afterwards |
| Player cap in the rules, not just the UI | Scripting past the room limit |

The timing check compares your submitted time against the gap between the `startedAt` and
`finishedAt` stamps written with `ServerValue.TIMESTAMP` — a clock the client cannot move.
It is deliberately generous (75% of the observed window, minus 4s) because those stamps are
bracketed by network round‑trips, so the server's window is always a little *longer* than the
real solve. The job is to make fabricating a time inconvenient, not to referee a competition.

### Heuristic only — Tier 2

- A time far below that player's own rolling average gets a ⚑ on the row. **Flagged, never
  blocked** — a genuine personal best is exactly this shape, and an app that eats your best
  solve of the year to protect a stranger has its priorities backwards.
- Joining a room forces the input source back to the real spacebar timer, so times cannot be
  typed in during a race.

Closing Tier 2 properly would need real server compute (a Cloud Function re‑validating each
submission). That is a genuine backend with code in it, not just rules, and it is not built.

**Local mode enforces none of this** and says so in the panel. Every tab is the same trusted
origin; the gate there is politeness, not a guarantee.

---

## 3. Running it locally (no setup)

```bash
python serve.py 5173
```

Open the timer, click the flag in the top bar, and press **Create a room**. Copy the invite
link into a second tab (or a second window) and both tabs are in the room. The host — whoever
joined first — presses **Start racing**.

Rooms live in `localStorage` and sync between tabs over `BroadcastChannel`. Nothing leaves the
machine, and no account is involved.

---

## 4. Turning on real rooms

1. Create a Firebase project. Enable **Realtime Database** and, under Authentication →
   Sign‑in method, enable **Anonymous**.
2. Paste the rules from [`firebase.rules.json`](firebase.rules.json) into
   Realtime Database → Rules, and publish. **Do this before step 3** — the config without the
   rules is a database anybody can write anything to.
3. Copy the config object from Project settings → General → Your apps → SDK setup and paste it
   into `FIREBASE_CONFIG` in [`js/raceapp.js`](js/raceapp.js).

That is the whole deployment. The site stays a static folder — there is no server to run, no
build step, and nothing new in the deploy pipeline.

**The API key is public, and that is normal for Firebase.** It identifies the project; it does
not grant access. The rules are what grant access, which is why step 2 comes first.

### Cost

The free (Spark) tier covers this comfortably. A race sends a few small text messages per
player per round — no media — against an allowance of 100 simultaneous connections and 10 GB
of transfer a month. Set a budget alert if you move to the paid tier. Check the current limits
in the console rather than trusting these numbers indefinitely.

### Developing against the emulator

To iterate on rules without touching a real project or burning quota:

```bash
firebase emulators:start --only database,auth
```

...then point `databaseURL` in `FIREBASE_CONFIG` at the emulator it prints.

---

## 5. How a round runs

1. **Lobby.** People join by code. The host presses Start.
2. **The host publishes one scramble** to `rounds/<n>/info`, generated by the app's own
   `ScrambleQueue` — the same official random‑state generator every other scramble comes from.
   The field is write‑once, so if two clients ever raced to open a round, one wins and both
   then race the winner's scramble.
3. **Everyone solves when ready.** The timer broadcasts only status transitions — never a
   running time.
4. **Finishing unlocks the room.** Your result is written, and only then does the client
   attach a listener to `results`.
5. **When everyone is done** (or the 45s grace runs out for stragglers) the leaderboard settles,
   the winner's client celebrates, standings update, and six seconds later the next round opens.

Round advance is a bump of `meta/round` by exactly one, guarded by a transaction, so every
client can attempt it and the duplicates are harmless.

**Host election is not a protocol.** The host is whoever joined earliest and is still present;
every client derives that from the same player list, so it re‑resolves for free when the host
leaves.

---

## 6. Where race solves go

By default each room gets **its own session**, named `Race · <CODE>`, so a race at somebody
else's pace never distorts the averages you are trying to read while practising. The times are
still saved, still browsable, still yours — and tagged `race: true` with the room id, so they
stay tellable from practice whichever session they landed in. Leaving the room puts you back in
the session you came from.

Turn it off in the Race panel if you would rather race solves counted with everything else.

---

## 7. Files

| File | What it is |
|---|---|
| `js/raceapp.js` | Everything you might edit: Firebase config, room caps, timeouts, anti‑cheat tuning |
| `js/race-net.js` | Transport. Two implementations (`firebase`, `local`) behind one small interface |
| `js/race.js` | Room/round state machine, reveal gate, standings, and the panel |
| `firebase.rules.json` | The rules that make the guarantees in §2 real |

The panel registers as a dockable tile, so it drags and docks like the times list and the stats
panel. Below 860px — where the tile system switches off — it becomes a sheet across the foot of
the screen, folded to a header that still answers the only two questions a phone has room for:
which room, and how much of it is already done.
