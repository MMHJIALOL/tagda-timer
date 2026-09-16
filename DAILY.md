# Scramble of the Day

Every day, every signed-in visitor gets the exact same scramble for a WCA event and
**one official attempt at it** — like a competition single, not a practice session. Solve it,
submit a time, and it lands on a leaderboard for that day. The board resets at a fixed
instant for everyone, everywhere: **00:00 IST**, no matter what timezone you are in.

Pressing the trophy in the top bar does not open a panel. It enters **the window**: a mode
where the topbar, both sidebars, the dock and the tiles are gone and what is left is today's
scramble, the timer, and a slim bar saying which day it is and how long is left of it. Submit
a time and the boards slide up over it — there are two of them, and they answer different
questions. See §5 and §6.

It rides on the same Firebase project [Race mode](RACE.md) already uses. If you have not set
that up yet, start there — this feature has nothing of its own to configure.

---

## 1. The design decisions worth knowing

**One reset, not one per timezone.** A "midnight where you are" reset would need a
different scramble per timezone, which breaks the entire point of a daily challenge — everyone
racing the same scramble. One fixed instant is simpler and fairer: everybody is up against the
same clock, just reading it at a different local hour.

**The clock is the server's, not the device's.** The day boundary is derived from Realtime
Database's `.info/serverTimeOffset` — a synthetic node with no rules to satisfy, the same trick
Race mode uses for `.info/connected`. Nothing about it can be moved by winding a device clock
forward to fetch tomorrow's scramble early, or back to get a second attempt into a fresh day
bucket.

**The database key is that boundary's epoch ms, not the date you'd expect to see.**
`daily/<dayId>/<event>` in the UI reads as `2026-09-08`, but on the wire the path is
`daily/<epoch-ms-of-that-day's-00:00-IST>/<event>` (`js/daily-net.js`'s `dayKeyFromServerMs`).
It is keyed that way so that a rule could compare the day against `now` — the rules language
has no date parser to pull a comparable instant back out of a string like "2026-09-08".

**That comparison does not work, and the rule no longer pretends to make it.** A `$capture`
from a path is a **string**; `now` is a **number**; the rules language is strictly typed and a
cross-type comparison is simply false. So `".validate": "$dayStart <= now"` was false for every
write, and because `.validate` is evaluated for the ancestors of a write and not only its leaf,
it refused **every** write anywhere under `daily/` — the scramble nobody could publish and the
progress nobody could report, both denied by a rule that was meant to be about future days.
Reads were unaffected, which is what made it look like a client bug for so long.

What is there now is the shape check the path can actually carry:

```
"daily": { "$dayStart": { ".validate": "$dayStart.matches(/^[0-9]{13}$/)", ... } }
```

**So the "no pre-publishing a future day" guarantee is not currently enforced.** It never was —
the rule that claimed it could not evaluate to true. Getting it back means giving the rule
something numeric to compare, which means putting the day's start inside the node as a value
rather than only in its key. That is a data-shape change and it is written down here rather
than done quietly: the exposure is that a signed-in visitor could pre-plant a future day's
scramble, and the cost of the fix is a migration.

**Status is public; times are private**, the identical split Race mode's rooms use:

```
daily/<dayId>/<event>/progress/<uid>   whether you've submitted today, and when you started/finished   ← anyone
daily/<dayId>/<event>/results/<uid>    how fast you actually were                                       ← gated
```

The read rule on `results` is what makes "nobody's time is visible to you until you have
submitted your own" real rather than a UI promise:

```
".read": "auth != null && data.child(auth.uid).exists()"
```

**Results are write-once** — one attempt per person per event per day, like a real
competition single. Without that, the read gate above would be its own exploit: submit a
throwaway time to unlock the board, read everyone else's times, then rewrite your own to just
beat the best one.

**…except the note.** Each row carries an optional one‑line note (80 characters, emoji
welcome), written from the board after you have submitted and editable afterwards. It is the
one field of a result that is not sealed, and it has its own `.write` to say so — a write rule
deeper in the tree ORs with the ones above it, so `note` stays editable while `timeMs` beside
it does not. Nothing in the ranking reads it, so there is nothing to gain by editing it.

**Your identity is your Google account, not an anonymous one.** Race mode signs you in
anonymously on purpose — a room's identity is meant to be throwaway. A leaderboard needs the
opposite: a name that is still you tomorrow and on your other devices. This feature rides on the
same signed-in account [cloud sync](README.md) uses, and does not stand up a third identity of
its own. Signed-out visitors can still watch the board — `scramble` and `progress` are public —
they just cannot appear on it or submit a time, which the rules enforce (`auth != null`), not
the UI.

---

## 2. Anti-cheat, honestly

Identical tiers to Race mode, reusing the exact same constants (`CLOCK_SLACK_MS`,
`CLOCK_SLACK_RATIO`, `SUSPECT_RATIO` — see [`js/raceapp.js`](js/raceapp.js)). No camera, no
microphone, no screen recording. Ever.

### Enforced by database rules — Tier 1

| Rule | What it stops |
|---|---|
| `results` readable only once your own exists | Reading the day's times before you've earned them |
| `results/<uid>` write-once (except `note`) | Submitting a decoy, peeking, then editing your time down |
| `timeMs` checked against the server-stamped solve window | Pausing the app and typing in a fabricated number afterwards |

The timing check is the same formula Race mode's rounds use: your submitted time against the
gap between the `startedAt` and `finishedAt` stamps written with `ServerValue.TIMESTAMP`,
generous by 25% plus 4 seconds because those stamps are bracketed by network round-trips. The
job is to make fabricating a time inconvenient, not to referee a competition.

### Heuristic only — Tier 2

A time far below your own rolling average gets a ⚑ next to it on the board. **Flagged, never
blocked** — a genuine personal best looks exactly like this, and a feature that eats your best
solve of the year to protect a stranger has its priorities backwards. Because the board resets
in 24 hours, a fake or flagged time is only embarrassing for a day — the same reasoning that
makes a daily board safer to run loosely than a permanent one.

---

## 3. Where the scramble comes from, since there is no server

There is no Cloud Function publishing scrambles on a timer — same honest limitation Race mode
already documents about its own rounds. Instead: whichever signed-in visitor opens the panel
first and finds today's event without a scramble generates one, via the same official
random-state generator every other scramble in the app comes from, and writes it write-once.
Anyone who loses that race gets the winner's scramble back a moment later.

In practice this means a new scramble appears within minutes of the boundary as long as
somebody visits shortly after it — not on the boundary to the second, and never before it.

### Two things make "write-once" actually true

The one promise this feature makes is that everybody, all day, gets the same scramble. Both
halves of keeping it were originally left to the database rule, and both have since had to be
made true on the client as well — the rule is published by hand, separately from the app, and
until somebody does that there is nothing enforcing any of this.

**Nobody publishes before they have looked.** `snap.scramble === null` is not "nobody has
published today's": it is equally "the listener has not delivered its first value yet", and
`watch()` emits once before that happens. Reading the first as the second meant every page load
raced its own read, and any load that won generated a fresh scramble and wrote it — so the
day's scramble changed on every refresh, for everyone at once. `snap.scrambleLoaded` is the
distinction, and `_maybePublishScramble` refuses to run until it is true. A node whose read was
*refused* never sets it: publishing into something you cannot read back is the same failure
with a worse cause.

**The write is a transaction, not a `set()`.** `set()` overwrites; `runTransaction` returning
`undefined` aborts, so an existing scramble is never replaced whatever the rules happen to
allow. Losing the race costs nothing — the loser is handed the winner's value in the
transaction result and adopts it without waiting for the listener.

---

## 4. Files

| File | What it is |
|---|---|
| `js/daily-net.js` | Day-id/countdown math and the solve-count math (both pure, tested in `test.html`), plus the Firebase transport |
| `js/daily.js` | The controller: attempt/submit flow, timer hooks, anti-cheat flags, the count push |
| `js/dailyui.js` | The window, and the two board renderers both it and the panel draw through |
| `js/panels.js`'s `buildDaily` | The drawer panel — event picker, countdown, both boards, no solving |
| `firebase.rules.json` | The rules that make §1's guarantees real, alongside Race mode's |

> **Republish `firebase.rules.json` before deploying this.** The previous rules end `results`
> with `"$other": { ".validate": false }` and know nothing about `photo`, so a client that
> sends an avatar has its *entire result* refused — the time is lost because of a picture.
> `js/daily.js` retries once without the avatar so a version skew costs a face rather than a
> result, and `dailyCount` simply does not exist until the rules are republished, so the
> solve-count board stays empty until then.

Turning it on needs nothing beyond what [`RACE.md`](RACE.md) already asks for: the same
Firebase project, the same rules file republished, the same config pasted into
`js/raceapp.js`. Without that configuration, the panel says so and stays inert — it does not
fall back to a local, unenforced mode the way Race mode does, because a daily leaderboard that
cannot be shared with anyone else has nothing to demonstrate.

---

## 5. The window, and why it is subtraction

The window is `sotd` on `<body>` and nothing else. It hides chrome, boosts the scramble into
the room the sidebars were using, and shows a bar and a board card that are ordinary markup in
`index.html` at all times.

It is deliberately **not** a modal with a timer of its own. That version was considered and
thrown away, because it would have needed its own copy of five things that were already right
somewhere else — inspection, +2/DNF judging, the hold time, stackmat input, the minimum-solve
prompt — and every one of them would have started drifting from `js/timer.js` the day after.
Worse, a solve done inside a private timer would not have been a solve: it would never reach
your session, your averages or your history, and *"my daily attempt is missing from my stats"*
is a far worse bug than any amount of chrome on screen.

So the window is a layout, and the solve underneath it is an ordinary solve that happens to be
of today's scramble. Two consequences worth knowing:

- **Leaving cancels an armed attempt.** Not the only defensible choice, but the honest one: an
  attempt you cannot see is an attempt that can be spent by accident, and today's is the only
  one you get.
- **The window arms itself when the scramble arrives**, not when it opens. Today's scramble is
  usually a beat late — somebody has to generate and publish it — and an earlier version
  checked once on the way in and never again, so the usual case was a window that never armed:
  the generator kept supplying ordinary practice scrambles, every solve was an ordinary solve,
  nothing was submitted, and the board therefore never unlocked either.
- **The window solves in the timer's event.** The solve underneath it is recorded against the
  timer's event and session, so entering the window points the controller at that event, and
  the panel's "Open" button moves the timer to the event picked there. The controller used to
  take its event once, when it was first built — do 4x4's scramble of the day, go back to 3x3,
  and the window stayed on 4x4 until a reload.
- **Nothing is armed on an answer that was never given.** Whether today is already spent is
  asked once per account, day and event, and "could not ask" (nothing watched yet, a failed
  read) is kept apart from "no". Treating the first as the second armed a fresh attempt on the
  day's scramble for a moment before the real answer took it back.
- **The timer is held shut whenever there is nothing official to solve** — no scramble yet, not
  signed in, or today's attempt already spent — and a message stands where the notation goes.
  `Daily#locked()` used to return `attempting`, the exact inverse of the same method in
  `race.js`: the timer was dead during the one solve it existed to time and live the rest of
  the time, which is what let the same scramble be "attempted" over and over with none of the
  attempts counting. Outside the window it is always false; practising is never this feature's
  business.
- **The board is on screen the whole time**, in a column down the left, below the scramble. It
  shows its locked state rather than nothing, because in the state where it is legitimately
  gated, saying *why* is the most useful thing the window can do. Signed out, it carries the
  sign-in button itself — telling somebody to use the account icon in a top bar this window has
  deliberately hidden was naming a control that was not on screen.
- **Signing out of a solve you cannot make.** Whether you may submit is `auth != null` in the
  rules, and the window says so where you would find out, not in a toast that vanishes.

Three layouts were tried for that column and the two that failed are worth recording, because
each looked reasonable:

  1. **A sheet across the bottom.** To be readable it had to cover the middle of the screen,
     which is where the timer is — so the time you had just done was dimmed to 12% to let the
     list through, making the single number you most want to read the least legible thing on
     screen.
  2. **A column beside the scramble.** Nothing overlapped, but the scramble had to be padded by
     the column's width to make room, and the line-fitter duly set it *smaller inside the
     window than outside* — the exact opposite of the point. Shifting the timer to match then
     put it visibly off-centre.
  3. **A column under the scramble**, which is what shipped. Nothing moves: the scramble keeps
     the full width, the timer stays centred on the screen where it always is, and the board
     occupies the empty left-hand region beside the digits. `js/dailyui.js` measures where the
     scramble actually ends rather than assuming a height, because a 5x5 scramble is two lines
     where a 3x3 is one. Below the timer's own breakpoint it lies back down along the bottom
     and is kept short enough that the digits stay visible.

### The chip in the top bar

`#btn-daily` is a gold pill reading **SOTD**, built on the same box as the account chip beside
it, with the trophy's cup filled so the silhouette survives at 17px. A row of identically
weighted grey outlines gives no clue that one of them is a thing that expires tonight.

Once you have submitted, the **invitation** stops: the gold, the label and the shine all go and
it settles back into the same quiet outline as the icons either side of it.

The button itself stays, and that distinction is the whole point. The first version hid the
chip outright — which removed the only route into the window, so the board you had just earned
a place on became unreachable until midnight. *Stop advertising it* and *take it away* are
different instructions and only the first one was ever wanted; there are now tests for both
halves.

The decision is made **without the network**, from a `tdt.sotd.doneDay` note in `localStorage`
compared against this device's own IST date — the chip is drawn on first paint, and loading
Firebase to render a top bar would throw away the entire reason `daily.js` is lazy. Storing the
*day* rather than a boolean is what makes the invitation come back after the reset. It is
cosmetic either way: editing it by hand restyles a button, and whether you may actually submit
is settled by a database rule that has never heard of it.

The note belongs to the **browser**, not to the account, so three things throw it away — and
all three are the same one-line `clearSotdDone()` in [`js/dayid.js`](js/dayid.js), which
forgets it and raises `sotd-done` so the chip redraws without a reload:

| when | why |
| --- | --- |
| signing out (`signOutUser`) | a signed-out visitor has no attempt in and cannot have one — they are exactly who the gold is for |
| boot with no session at all (`startCloudSync`) | the sign-out may have happened on another device; not having a session is how this one finds out |
| the database says this account has no result today (`_checkOwnResult`) | covers switching accounts on one browser, and a result that has since gone |

Without them the note simply outlived the account that earned it: sign out and the chip stayed
retired all day, on a page where signing back in was the only thing it was asking you to do.
- **Esc leaves, except mid-solve**, where it still means "abandon this solve". The window asks
  the timer whether it is busy rather than reaching into it.

---

## 6. The second board: most solves today — built, then switched off

**Currently off.** `SHOW_COUNT_BOARD` in [`js/daily.js`](js/daily.js) is `false`, and while it
is, the board is not drawn in either the window or the panel and nothing writes to
`dailyCount`. Everything below still exists and is still tested; flipping that one boolean is
the whole of turning it back on. The rules for `dailyCount` are left in place so that turning
it on later does not need a rules deploy to go with it.

It went because two boards side by side invited a comparison between them that neither
survives. The time board is a competition single with a server-timed window behind it; this one
counts spacebar presses and says so. Sitting in one card implied they were the same kind of
claim.

The rest of this section describes it as built.

Alongside "who was fastest at today's scramble" there is "who did the most solves today" — of
anything, any event, whether or not the daily scramble was one of them. It resets on the same
boundary, because it hangs off the same `<dayKey>`.

**Nothing increments it.** Each client counts its own solve list against the day window
(`countSolvesForDay`) and writes the *total*; the rule only lets that number climb:

```
".write": "... && (!data.exists() || newData.child('n').val() >= data.child('n').val())"
```

Three things fall out of writing a total rather than a delta: the count is a pure function of a
list you already have, so it is testable without a database; a solve done offline is not lost,
because the next write is a total rather than an event that needed to happen at the time; and
it does not require `daily.js` to have been loaded at the moment you solved, which an
increment-per-solve design would have quietly demanded.

**What it cannot do is verify anything, and this is worth saying plainly.** The time board has
teeth — a server-timed window, a write-once result, a reveal gate. A count has none of that
available to it. There is no scramble a counted solve had to be a solve *of*, and no timed
window to check it against, so holding the spacebar forty times looks exactly like forty
solves. It is a volume board, it resets in 24 hours, and nothing depends on it. The board is
public to read for the same reason: a count gives away nothing about a scramble you have not
attempted yet, so there is no reveal gate to build.

### Avatars, and why the URL is pinned to one host

Avatars come from the Google account picture already attached to the signed-in identity, are
written alongside a name that was already public, and are never uploaded anywhere — the `photo`
field is a URL Google serves. No picture falls back to an initial on a tinted disc, which is
what most rows will actually be.

The field is **restricted to the account-picture host**, in the rules and again in the client:

```
"photo": { ".validate": "... newData.val().matches(/^https:[/][/]lh[0-9]+[.]googleusercontent[.]com[/]/)" }
```

That restriction is not tidiness. A row is written by somebody else and its `photo` becomes an
`<img src>` in every viewer's browser, on a board that is public to read. Left as "any string
under 300 characters", any signed-in person could write `https://their-server/x.png` straight
to the database — no help from this app needed — and every visitor who opened the board would
hand that server their IP and user agent, on every redraw. A tracking beacon on a public page
is worth considerably more to an attacker than the fake solve count this board is already
honest about not policing, so it is the one thing here that *is* policed.

`js/daily-net.js`'s `safePhotoUrl` is the same check in the client, and it earns its place
twice over: it is what protects viewers from rows written before the rule existed, and
filtering on the way out means an unexpected provider URL costs a row its face rather than
failing the whole write and costing it its place on the board.

### One more thing the boards need: to actually roll over

`watch()` recomputes the day from the server clock and resubscribes when it finds a new one,
but for a long time nothing asked it to. It ran once on connect and again only if you touched
the event picker, so a tab left open across 00:00 IST sat on yesterday's board indefinitely —
with the countdown stuck on "under a minute", because the reset it was counting towards had
already been and gone. `Daily#checkRollover` is now called from the same one-second tick that
draws that countdown, in both the window and the panel, so the thing that would show the
problem is the thing that fixes it.
