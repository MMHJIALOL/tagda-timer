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
`CLOCK_SLACK_RATIO`, `SUSPECT_RATIO` — see [`js/raceapp.js`](js/raceapp.js)). A camera is never
*required*: nothing here checks for one, and no time is judged on a video. Webcam replay is
your own choice, the clip stays on your device, and sharing it with the day's board is opt-in,
one press at a time or a setting you turn on yourself (§8).

### Enforced by database rules — Tier 1

| Rule | What it stops |
|---|---|
| `results` readable only once your own exists | Reading the day's times before you've earned them |
| `results/<uid>` write-once (except `note`) | Submitting a decoy, peeking, then editing your time down |
| `timeMs` checked against the server-stamped solve window | Pausing the app and typing in a fabricated number afterwards |
| `backup` readable only once your own `backupClaim` exists | Looking at the backup scramble without giving up the main attempt |
| a claim forces `backup: true` on your result, and `backup: true` needs a claim | Peeking at the backup and then submitting as though you never did |
| only an admin (`admins/<uid>`, [ADMIN.md](ADMIN.md)) deletes a result, and only with a `removed/<uid>` record in the same write | A sus time staying up, and a removed one coming back as a second go at the main scramble |

The two backup rows are §7; removals are §10.

The timing check is the same formula Race mode's rounds use: your submitted time against the
gap between the `startedAt` and `finishedAt` stamps written with `ServerValue.TIMESTAMP`,
generous by 25% plus 4 seconds because those stamps are bracketed by network round-trips. The
job is to make fabricating a time inconvenient, not to referee a competition.

`finishedAt` is stamped when the timer **stops** (progress status `stopped`), not when the
result is sent. It used to be stamped at submit, which was harmless while submitting followed
the stop by a few milliseconds. The misfire question in §7 can put minutes between the two (a
reload before answering it), and all of that would have counted as solving time, so the check
would have refused a time that was kept.

### Heuristic only — Tier 2

A time far below your own rolling average gets a ⚑ next to it on the board. **Flagged, never
blocked** — a genuine personal best looks exactly like this, and a feature that eats your best
solve of the year to protect a stranger has its priorities backwards. Because the board resets
in 24 hours, a fake or flagged time is only embarrassing for a day — the same reasoning that
makes a daily board safer to run loosely than a permanent one. A person decides instead: the
admin can take a time down by hand, and its owner gets the backup scramble (§10).

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

Which events have a daily scramble at all is a setting too (`config/sotd/events`, every eligible
event by default): an event switched off has no window, board or chat, and its data stays.

**A day ahead.** Anybody signed in may publish **today's** scramble, once (with five minutes either
side of midnight for a clock that is a little out). Only an admin may write a **later** day's, from
the admin console's *Days ahead* ([ADMIN.md](ADMIN.md) §11), and change or clear it until that day
starts; on the day it is the scramble everybody gets, written once like any other. Until this rule,
anybody could plant tomorrow's scramble and practise it. An admin can also make an event the day's
**featured event** (`sotdFeatured/<dayStart>`): it is starred in the panel's event list, and the
window's board says so, with *Go to it* from any other event.

## 4. Files

| File | What it is |
|---|---|
| `js/daily-net.js` | Day-id/countdown math and the solve-count math (both pure, tested in `test.html`), plus the Firebase transport |
| `js/daily.js` | The controller: attempt/submit flow, timer hooks, anti-cheat flags, the count push |
| `js/dailyui.js` | The window, and the two board renderers both it and the panel draw through |
| `js/panels.js`'s `buildDaily` | The drawer panel — event picker, countdown, both boards, no solving |
| `firebase.rules.json` | The rules that make §1's guarantees real, alongside Race mode's |
| `tools/verify-misfire.mjs` | `node` check of the misfire thresholds in `js/dayid.js` (§7) |
| `js/sotd-replays.js` | Shared replays: Share replay, the ▶ on the boards, fetching and caching clips (§8) |
| `worker.js` | The `/replay/*` routes and their limits, in front of the R2 bucket (§8) |
| `tools/sotd-replay-dev.mjs` | One command for the emulators and `wrangler dev`, to test §8 and §9 locally |
| `js/sotd-chat.js` | The day's chat: the column, the composer, deleting (§9) |
| `tools/verify-sotd-chat-rules.mjs` | `node` check of the chat's rules against the database emulator (§9) |
| `tools/verify-sotd-remove-rules.mjs` | `node` check of the admin removal rules against the database emulator (§10) |
| `tools/verify-safety-rules.mjs` | `node` check of the admin console's switches and bans on the chat, the board and replays ([ADMIN.md](ADMIN.md)) |

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

Shared replays (§8) need one thing more: the R2 bucket `tagda-replays` bound in
`wrangler.jsonc`, private, with a rule deleting objects 8 days after upload. Without the new
rules published, sharing says it is not switched on yet and touches nothing.

The chat (§9) needs only the rules republished. Until then the window has no chat at all.
Admin removals (§10) are the same: until then the × is drawn, and pressing it is refused.

Since the admin console ([ADMIN.md](ADMIN.md)), an admin is whoever `admins/<uid>` says in the
database, not a uid written into the rules. Add yourself there **before** publishing them: until
the entry exists, the rules refuse your × and your chat deletes, and the app stops drawing them.

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
  one you get. The exception is a solve already done and waiting on the misfire question
  (§7): leaving answers that question **Keep**, and the time is submitted.
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

**Currently off.** `config/sotd/countBoard` is off (the admin console's *Scramble of the Day*
section, [ADMIN.md](ADMIN.md) §3; `showCountBoard()` in [`js/daily.js`](js/daily.js)), and while
it is, the board is not drawn in either the window or the panel and nothing writes to
`dailyCount`. Everything below still exists and is still tested; that one switch is the whole of
turning it back on. The rules for `dailyCount` are left in place so that turning
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

---

## 7. Misfires and the backup scramble

A stackmat or spacebar misfire on today's scramble used to cost the day: the attempt was
recorded and submitted however it ended. Now a short solve of the **main** scramble can be
traded for a **backup** scramble, once per day per event.

### The thresholds

Judged on the raw time **before** any penalty — a +2 does not lift a 1.5 s misfire over the
line. The two cut-offs below are the defaults: the admin console can move them
(`config/sotd/autoDiscardMs` and `askMs`, ADMIN.md §3), and the ask line never sits below the
discard one. `misfireAction` in [`js/dayid.js`](js/dayid.js) (re-exported by `daily.js`, checked by
`node tools/verify-misfire.mjs`):

| Time | What happens |
|---|---|
| < 2.00 s (`AUTO_DISCARD_MS`) | Thrown away: not recorded locally, not submitted — **ever**. The backup comes up at once, with a 5 s toast. If the backup can't be had (rules not published), today's scramble comes back instead. |
| 2.00–4.99 s (`ASK_MS`) | "{time} — misfire? **Use backup** / **Keep**". No answer within 5 s, leaving the window, or reloading all mean Keep. The timer is shut while the question is up, so space can't start a stray solve. |
| ≥ 5.00 s | Unchanged: recorded and submitted straight away. |

**2x2, Pyraminx, Skewb and Clock are exempt** (`FAST_EVENTS`): real solves come in under 2 s
there, and a 2–5 s question would come up on nearly every one. They behave as before.

Toasts about the attempt (thrown away, switched, kept, refused) stay up 5 s — the `hold`
lifetime. At 1.5 s the one explaining a kept misfire was gone before anybody had read it,
behind the post-solve fade.

This applies whatever the Confirm misfires setting says, and inside the window it **replaces**
the generic "Discard it?" question rather than joining it. That generic discard was itself a
hole: it put today's main scramble straight back up for a free second go.

A solve **of the backup** is always submitted immediately, with no question: there is nothing
left to fall back to. One under 2 s goes in as a **DNF**, not as its time — submitted as-is, a
1.5 s misfire on the backup was the best time on the board. Taking the backup spends the first
attempt for good; you can never pick the better of the two, because the first one was never
recorded anywhere.

The bar says `backup scramble — final attempt` (in the warn colour) while you are on it.

### Where the backup lives, and why nobody can read it early

```
daily/<dayKey>/<event>/
  backupClaim/<uid>   server ms. Write-once, own uid only, only while progress/<uid> exists
                      and results/<uid> does not. Readable by its owner (so a reload knows).
  backup              the scramble. Readable ONLY by a uid whose backupClaim exists.
                      Writable once, and only by a claimer.
  results/<uid>/backup  true, or absent. A claim requires it; it requires a claim.
```

Hiding the backup in the UI would be nothing: the database is readable from the console and
over REST. The read rule is what makes it private, and it has no way round it — the parent
nodes (`daily/<dayKey>`, `daily/<dayKey>/<event>`) have no `.read` at all, so a whole-node or
`?shallow=true` read is refused too.

**The claim comes before the read, on purpose.** Claiming is the point of no return: until
it lands the backup cannot be read, and once it has, the rules only accept a result marked
`backup: true`. So seeing the backup always costs the main attempt and always shows on your
row, however the database is reached. There is no way to look at both and choose.

**Nobody can generate it in advance.** The first claimer generates it (the same official
random-state generator) and writes it with a transaction that never replaces an existing
value, exactly like the main scramble in §3. Everybody who claims later reads the same one.
It cannot be published alongside the main scramble, because then whoever published it would
have seen it without claiming.

**The clock check still holds for a backup solve.** Switching removes `startedAt` and
`finishedAt` from your progress, and the backup solve stamps its own. Without that, the check
would compare the backup time against a window that began with the solve thrown away.

### Loopholes closed

- **Reload or close the tab with the question up.** The solve is noted in `localStorage`
  (`tdt.sotd.held`, keyed by account, day and event) before the question is asked. The next
  time the window opens, that note is answered Keep and submitted — instead of arming a fresh
  attempt at a scramble already solved once. The same note covers the moment between a
  sub-2 s stop and its claim landing.
- **Esc or Leave with the question up** answers it Keep.
- **A claimed backup survives a reload.** On connect the controller reads
  `backupClaim/<uid>` before arming anything; if it exists and there is no result, the backup
  is armed, not the main scramble.
- **The day rolling over** (`checkRollover`) resets all backup state.

**Not closed, and pre-existing:** a solve that has *started* on the main scramble can still be
abandoned — Esc mid-solve, the Leave button mid-solve, or a reload — and the main scramble is
armed again. Progress says `solving`, but nothing reads it on the way back in. Closing that
needs a decision about what an abandoned attempt counts as (a DNF, like a competition), so it
is tracked separately rather than folded into this.

### Until firebase.rules.json is republished

The rules above are not live until they are pasted into the Firebase console. Until then the
claim is refused, and:

- **under 2 s** the solve is still thrown away, and **today's main scramble is armed again**
  (toast: "Misfire — thrown away. The backup scramble isn't available yet, so today's
  scramble is yours again"). The first version kept and submitted it, which is how a 0.62
  reached the top of the live board on 2026-09-27. A sub-2 s 3x3 is never a real solve and
  the main scramble is public anyway, so a second go at it gives nothing away.
- **2–4.99 s with Use backup** keeps and submits the time, and says so for 5 s ("Backup
  scramble isn't available yet — your time was kept"). This could be a real solve, so it is
  not thrown away without somewhere to go.

Reading `backupClaim` on connect is refused too, which is read as "no claim". A backup result
refused for its unknown `backup` field is retried without it, the same way `photo` is.

### Tested

Rules: 44 checks against the Realtime Database emulator (firebase-tools 13, real anonymous
Auth-emulator tokens) covering every read and write path above, plus the old rules refusing
claims and `backup: true`. Client: Playwright in Chrome and Firefox against the emulators —
auto-switch at 1.2 s, Keep and Use backup at 3.5 s, the same backup for a second user after
(and only after) claiming, reload and Esc with the question up, space doing nothing while it
is up, 8 s straight through, the tag on today's board and on the history view, how long each
toast stays up, and both fallbacks under the old rules (sub-2 s thrown away with the main
scramble re-armed; Use backup kept).

---

## 8. Shared replays

With [webcam replay](README.md#webcam-replay) on, the day's attempt is filmed like any other
solve: the clip is kept on your device against that solve and plays from the times list. After
you submit, **Share replay** under the board uploads a copy of it, and everyone who has
submitted the same day's attempt for the same event can watch it, for 7 days after the day.
Nothing goes up until you press it, unless you have turned on **Always share my SOTD replay**
in the camera panel (off by default). The camera panel opens from the button in the window's
own bar too, since the top bar is hidden in here.

- **Watching** is gated exactly like the times: nothing until you have submitted your own.
  Rows with a shared clip get a ▶ on the time board, and the **Replays** view beside it lists
  only those. Past days in the picker work the same; a day more than 7 days over says
  *Replays are kept for 7 days*. Nothing loads until ▶ is pressed, and a clip fetched once is
  kept in memory for the page, so watching it again asks for nothing.
- **The player** is the ordinary one, run with the uploader's clock delay for their camera
  (`adj`) so the clock lines up with their hands, under their name, and without keep, delete,
  clock delay or Save video. An admin gets **Remove**.
- **Your own share**: *Preparing… / Uploading n%*, then **Shared · Watch · Remove**. Watch
  plays your local clip. Remove is for good that day (it says so first): the claim below stays,
  so the same account cannot share again for that event until tomorrow.
- **The copy** (`replay-media.js` `shareCopy`): the filmed size up to 720p (long side 1280),
  never upscaled, 30 fps, a keyframe every 0.5 s for seeking, video bitrate
  `min(1.5 Mbps at 720p / 0.6 Mbps at 480p, CLIP_MAX × 8 × 0.9 / duration)`. Under 0.5 Mbps at
  720p it steps down to 480p; under 150 kbps the clip is too long to share and says so. Sound
  only with **Include sound** ticked (shown only when the clip has sound); otherwise the track
  is left out. A browser that cannot encode copies the frames into a new file as they are,
  sound dropped, if that fits. The clip on your device is never changed.

### Where it lives

```
R2 bucket tagda-replays (never public)
  r/<dayKey>/<event>/<uid>   the clip. Custom metadata: v, mime, insp, start, stop, timeMs,
                             w, h, fps, lat, adj, sound, at. No camera or microphone name.

daily/<dayKey>/<event>/
  replayClaim/<uid>          server ms. Write-once, own uid only, only once results/<uid>
                             exists. Readable by its owner. Deleted only when an admin
                             removes that time (§10), so the backup solve can be shared.
  results/<uid>/replay       true, or absent. Its own .write (owner only, like note), and
                             true only with a claim. The ▶ and the Replays view come from this.
```

The Worker (`worker.js`, `/replay/*`) is the only way to the bucket:

| Request | Who | Order of checks |
|---|---|---|
| `PUT /replay/<dayKey>/<event>` | you, your clip | path, and today's or yesterday's day → switched on (`config/replays`) → headers (meta, type, length) → the body really that size, really WebM or MP4 → Google sign-in, a result on the board, not banned → **the claim** → the day's count entry → `list` the day: fewer than the day's clips, under DAY_BUDGET → `put`, then the flag |
| `GET /replay/<dayKey>/<event>/<uid>` | anyone with a result that day | path → switched on → not past 7 days → reading `results/<uid>` with your token (allowed only once yours exists) and its flag → `get` |
| `DELETE /replay/<dayKey>/<event>/<uid>` | the owner, or an admin (`admins/<uid>`; `ADMIN_UIDS` while the rules are older, [ADMIN.md](ADMIN.md)) | path → token → the flag (owner) → `delete` |

400 bad path or day, 401 token, 403 not submitted, not a Google account, or banned, 404 removed,
409 already shared today, 410 past 7 days, 411 no length, 413 over CLIP_MAX, 415 not a video,
429 the day's replay slots are full, 503 switched off (`off`, with the admin's message) or rules
not published yet (`not-enabled`), 507 the day is full.

**The admin console can tighten every one of these and loosen none** ([ADMIN.md](ADMIN.md) §4):
switch sharing and watching off, take the day's clip count below 1000, a clip below 10 MB, the
day below 1 GB, or the days kept below 7. The Worker reads `config/replays` about once a minute
and always uses `min(setting, the constant)`. Every step before the claim (the switch, a ban, the
size) costs the person nothing; a day that is full is found out after it, and the app reads the
day's count (`replayDay/`) before uploading so that rarely happens. A clip is served with its stored type
(WebM or MP4 only), `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` and
`Cache-Control: private, max-age=86400`: these are strangers' uploads on tagdatimer.me.

**No crypto in the Worker.** The ID token goes to the database's REST API as `?auth=`, never
as a Bearer header (the REST API takes that as an admin credential and skips every rule). A
read the rules allow proves the token is genuine, and only then is its payload decoded for the
uid and `sign_in_provider`. A garbage token gets 401 from the production database (checked
read-only on 2026-10-05). Only Google accounts can share: race mode signs people in
anonymously on the same project, and anyone can mint anonymous tokens with the public key.

**Retention is exact in the app**: the Worker treats a clip as gone once `now > dayKey + 8
days` (7 days after the day ends), whatever the bucket's lifecycle rule has got round to.

### The money rule

R2 has no spending cap: going past the free tier bills the card instead of failing. So the code
has to make going over impossible.

| R2 meter | Free a month | What keeps it under |
|---|---|---|
| Class B (get, head) | 10M | Every read is a Worker request, at most one `get` each, and Workers Free stops at 100k requests a day: at most ~3.1M a month. The bucket has no public route (no r2.dev, no domain). |
| Class A (put, list) | 1M | Nothing touches R2 for an upload until the write-once claim lands, one per Google account, event and day; after it, one `list` and one `put`. 50 parallel uploads from one account reach R2 once (tested). |
| Storage | 10 GB-month | CLIP_MAX 10 MB a clip, DAY_BUDGET 1 GB a day for all events, and an 8-day lifecycle rule (plus up to 24 h before R2 acts): at most about 9 GB at peak. More than one page (1000 clips) in a day counts as full. |
| Deletes, egress | free | — |

The Worker itself stays on **Workers Free**, where every limit fails rather than bills, and
static assets are not metered: `run_worker_first` is `/__/auth/*` and `/replay/*` only.

An admin removal (§10) clears the person's claim, so they can share once more: one more
`list` and `put` per removal, done by hand, one row at a time.

The day's count is `replayDay/<dayKey>/<event>/<uid>`, one entry per claim, written by the Worker
right after it with the person's own token. The rules allow an entry only for an account that has
a claim, once, so it can never count more claims than there are; anybody signed in may read it and
nobody may delete it, except the sweep of days older than yesterday (§9's, once a day).

Two honest edges. Class A is bounded by claims, so going over would take roughly 16,000
claims a day, every day for a month: over a thousand Google accounts each submitting every
event daily. And DAY_BUDGET is checked with a `list` before the `put`, so uploads racing at the
same moment can each pass it: the day can run over by at most one clip per upload in flight.
A viewer's browser may keep a clip it has already watched for up to a day after it is removed
(the `private, max-age=86400` above); everybody else gets *That replay was removed*.

Every refusal is a toast (*Replay space for today is full*, *Couldn't load the replay, try
later*): the solve, the time and the board are never touched. There is no polling, and a
request is retried at most once, and only after a network error.

### Until firebase.rules.json is republished

The claim has no rule to allow it, so the Worker answers 503 and the app says *Sharing replays
isn't switched on yet*. Nothing reaches R2, and nothing is written from the browser that could
be rolled back off your board row (the claim is the Worker's write, and the flag fallback only
runs after a share succeeded).

### Testing it locally

`node tools/sotd-replay-dev.mjs` starts the Realtime Database and Auth emulators and
`wrangler dev` (R2 simulated on disk) and prints the URL. `?emu=1` on localhost points the app
at the emulators, and sign-in is the emulator's fake Google account chooser. `--reset` wipes
the clips, `--old-rules` starts on the rules from before the chat (`rules old|new` swaps them
live, `rules pre-replays` goes back to before replays), `--budget <bytes>` shrinks DAY_BUDGET,
and `counts` prints the R2 operations so far.

---

## 9. The day's chat

Once your time is in, a chat opens down the right of the window, opposite the board: one room
per event per day, for everybody who has done that scramble. Below the timer's breakpoint
there is no right-hand column, so it is a **Chat** tab on the board's sheet instead, with a
**‹ Board** to go back. It looks like Race mode's chat (it reuses its classes), with a face
beside each name, because these are the same Google accounts every day.

**Behind the board's gate, word for word.** `chat` is readable only by an account with a row
in that day's `results`: the same rule as the times. The one exception, for both, is an admin
([ADMIN.md](ADMIN.md) §6), who reads every room and board of the day to moderate them. A room you could read before your attempt
would be a way round that gate. "Free x-cross on white" is help on somebody's one attempt.

```
daily/<dayKey>/<event>/chat/
  m/<pushId>     { uid, name, text, at, photo? }
  last/<uid>     server ms of that account's last message
```

What the rules ask of a message:

- **A Google account** (`auth.token.firebase.sign_in_provider === 'google.com'`) with a result
  for that day and event. Race mode's anonymous identities cannot post.
- **Today's room only.** `$dayStart === '' + (now - ((now + 19800000) % 86400000))`: the
  server's own 00:00 IST, made a string. Comparing a path key with `now` directly is false
  (§1); turning `now` into a string first works, and is what this whole section rests on.
- `uid` is yours, `name` 1–32 characters, `text` 1–200, `photo` a Google avatar (§6), `at`
  exactly `now` (send `ServerValue.TIMESTAMP`). Nothing else. Never edited.
- **1.5 s apart.** The message and `last/<uid>` go in one update, each wanting the other to
  carry the same `now`, and `last` refuses a value less than 1.5 s after the one it replaces.
  The app waits 2 s between sends, so a fast connection after a slow one is not refused.
- **The admin console** ([ADMIN.md](ADMIN.md) §4) can switch posting off, make the gap longer
  (`config/sotdChat/gapMs`, never shorter than 1.5 s) or messages shorter (`maxLen`, never longer
  than 200). The rules read those directly, with the numbers above when nothing is set; the app
  waits half a second more than the gap, and puts the admin's message where the box was.
- **Not banned** (`bans/<uid>`, ADMIN.md §5). A banned account's box shows why instead.

**Reporting.** Beside somebody else's message there is a ⚑ (next to where the × would be): it
asks first, then files a report for the admins (`reports/`, one per account per message,
ADMIN.md §6). A shared replay has **Report this replay** in the player's **⋯**.

**Deleting.** Your own messages, from the × on hover (always showing, faintly, on a touch
screen), after a confirm. An admin (a Google account with `admins/<uid>: true` in the
database, [ADMIN.md](ADMIN.md); the app asks `admins/<uid>` once to draw the button) can delete
anybody's, in any room, without a result of its own. An admin reads a room the same way as
everyone else, though: after doing that event's scramble. In the chat the owner's badge goes by
the owner's uid (`OWNER_UID` in `js/ownercard.js`), not by name as on the board: a message's uid
is pinned by the rules, and a name is free text anyone can type. The badge is cosmetic; being an
admin is the database's say.

**At the reset.** Nothing has to happen at 00:00 IST for the room to vanish: the window reads
the new day's path, which is empty, and every screen moves to it. The stored copy goes later.
The first signed-in visitor of a day sends one update per day for the 7 days before it,
setting every event's `chat` to null (`sweepOldChats`, five seconds after the window
connects, once per browser per day). The rules let anybody signed in delete a whole room on
any day but today, so the sweep needs no read, no server and no cron. A clock that is slightly
off can only fail to clean; it can never clean today.

**What it costs.** A message is about 150–350 bytes. Storage holds at most a day of chat (plus
any days nobody visited), so it stays in kilobytes. Download is the meter that grows: every
message goes to everyone with the room open, and opening it loads the newest 60. The chat uses
the connection the window already has, so it adds no connections.

**Until firebase.rules.json is republished** the read is refused and the window has no chat
column at all. Nothing is shown or toasted about it; the sweep is refused once a day per
browser, with a console warning. Nothing else changes.

**Testing it.** `node tools/verify-sotd-chat-rules.mjs` checks the rules against the database
emulator (in a namespace of its own, so a running `sotd-replay-dev.mjs` is untouched).
`node tools/sotd-replay-dev.mjs`, then two browsers (or one private window) on the printed URL,
each signed in with "Add new account". Both solve today's scramble, then talk. The account
chooser also has **Admin**, an account listed under `admins/`, for the delete buttons on
other people's messages.

---

## 10. Removing a time (admin)

An admin (§9, [ADMIN.md](ADMIN.md)) gets a × on every row of a board, faint until the
row is hovered and always faintly there on a touch screen. It is on today's board in the
window and in the drawer, and on past days in the picker. Pressing it asks first, saying
what will happen, then takes the time off. Nobody else gets a ×, and nobody can take their
own time down: that would be a free second go.

What happens to the person depends on which scramble the time was on:

- **The main scramble**: they get the **backup** scramble as a final attempt (§7). If their
  window is open, it moves there at once ("An admin removed your Scramble of the Day time.
  You get the backup scramble — final attempt."). If it is not, it opens straight onto the
  backup next time. Until they submit, their board and chat are locked again, saying why.
- **The backup**: that is their day. The bar says *time removed — no attempts left today*,
  the timer stays shut, and the board stays locked until the reset.
- **A past day's board**: the row just goes. There is no attempt to give back.

The admin can remove their own time too, and gets the backup like anyone else. If the row
had a shared replay, the clip is deleted from the bucket as well (deletes are free).

### What one removal writes

One update to `daily/<dayKey>/<event>`, so it all lands or none of it does:

```
results/<uid>             null. The board and the chat lock for them (the rules' gate).
removed/<uid>             { at: now, final }. Readable by its owner only; this is what
                          their app watches. `final` is whether the time was already on the
                          backup, and the rules check it: it must equal "a backupClaim exists".
progress/<uid>/submitted  null, so "n people have done today's scramble" drops by one.
replayClaim/<uid>         null, so a replay of the backup solve can be shared (§8).
```

What the rules ask:

- **Only an admin** (`admins/<uid>`), and the row's delete and the record have to arrive together: a
  delete without a fresh `removed/<uid>` (its `at` is the server's `now`) is refused, and so
  is a record for somebody with no row, or one that leaves the row in place. Nobody can
  delete or rewrite a record afterwards, the person included.
- **A new result after a removal** must be on the backup (`backup: true`, which already
  needs a claim) and is refused outright once the record says `final`. So a removed person
  can never go back to the main scramble, and a removed backup is the end of the day. The
  claim's own rule is unchanged: it needs `progress/<uid>`, which a removal leaves in place.
- `progress/<uid>/submitted` and `replayClaim/<uid>` can be cleared by the admin only in
  the same write as a removal.

### On the person's side

`js/daily-net.js` watches `removed/<uid>` for the watched day, event and account, and
`_checkOwnResult` reads it alongside "do I have a result?" on every connect. A record newer
than the last one acted on is a fresh removal: the results and chat listeners are dropped
(the rules have already cut them off), the toast goes up, and the check runs again. With no
result and a non-final record it claims the backup itself, exactly as a misfire would, and
arms it. A refused claim is retried a few times and says so on the scramble line.

### Until firebase.rules.json is republished

The update is refused as a whole, nothing moves, and the admin gets *The board refused that —
firebase.rules.json needs publishing first*. Reading `removed/<uid>` is refused too, which is
read as "never removed". Nothing else changes.

### Testing it

`node tools/verify-sotd-remove-rules.mjs` (45 checks, its own namespace) covers every path
above: who may remove, the record's shape, the lock, the backup after a removal, a removed
backup being final, the admin's own time, a past day, and everybody else being untouched.
In the app, `node tools/sotd-replay-dev.mjs` and its **Admin** account: both submit,
then the admin hovers the other row.
