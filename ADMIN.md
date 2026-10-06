# The admin console

**tagdatimer.me/admin** is a page for the site's admins: the app's settings, changed from a
phone without touching code, bans, and a log of every change with an **Undo** on each one.
Anybody can open the address; only an account listed under `admins/` in the database gets past
the sign-in, and the database refuses everybody else's writes whatever the page shows them.

It is built in phases. Phase 1 laid the ground: who is an admin, the settings node and its rules,
the change log and the page. Phase 2 put real switches on it: shared replays, both chats, race
rooms, bans, and a way to make every open tab reload onto a new deploy (§4, §5). Phase 3 added
moderation: a report button, and one place to read every chat, flagged time and shared replay
of the day and take any of it down (§6).

![The admin console on a phone: the sections, a form with unsaved edits, the review before saving, and the change log](docs/screenshots/admin-phone.webp)

<details><summary>The same in the light theme</summary>

![The admin console on a phone, light theme](docs/screenshots/admin-phone-light.webp)

</details>

---

## 1. Turning it on

Once, in this order:

1. **Add yourself as an admin.** Firebase console → Realtime Database → Data. On the root,
   add a child `admins`, and under it a child named by your uid with the value `true` (the
   boolean, not the text `"true"`). The owner's uid is `8lSr96LEO1cdHDVlMDv8tCCFQag1`; anybody
   else's is in Authentication → Users. The console writes past the rules, which is the only
   way this node is ever written.
2. **Publish `firebase.rules.json`.** Realtime Database → Rules, paste, Publish.
3. **Deploy** as usual. Nothing new in `wrangler.jsonc`, no secret, no bucket.
4. Open **tagdatimer.me/admin** on the phone and sign in with the same Google account as the
   timer. *Add to Home Screen* (Safari's share sheet, or Chrome's menu) puts it there as
   **Tagda Admin**, with its own icon.

Step 1 comes first because the new rules stop trusting the uid they used to hard-code. Publish
them first and, until the entry exists, the rules refuse your SOTD × and your chat deletes, and
the app stops drawing them.

**Another admin** is the same as step 1 with their uid. **Removing one** is deleting their entry:
the database refuses their writes from that moment, cuts off an admin page they have open, and
the page drops to *This page is for the site's admins*.

---

## 2. Who is an admin

```
admins/<uid>: true      written by nobody from the client: the console only
                        readable by admins (the whole list), and by each account (its own entry)
```

In the rules, everywhere an admin may do something, the test is the same words:

```
auth != null && auth.token.firebase.sign_in_provider === 'google.com'
             && root.child('admins/' + auth.uid).val() === true
```

**Only Google sign-ins.** Race mode signs people in anonymously on the same project, and anyone
can mint an anonymous account with the public API key. Such an account never counts, even if
one were added to `admins/` by mistake (`tools/verify-admin-rules.mjs` tries exactly that).
Anything but `true` (`"yes"`, `1`) is not an admin either.

**Each account can read its own entry.** The brief said admins only; this goes one step past it,
on purpose. It lets the app and the Worker ask *am I an admin?* with one read of `admins/<uid>`,
and the answer gives away nothing but your own flag. The list as a whole is admins-only.

Where it is checked:

| Where | What an admin may do |
|---|---|
| `firebase.rules.json` | read every day's SOTD board and chat without having solved; read every race room; delete anybody's SOTD or race chat message; remove a SOTD time (`results`, `removed`, `progress/<uid>/submitted`, `replayClaim`, all in one write, DAILY.md §10) or a race time; clear a replay's flag; write `config`, `configMeta`, `configLog`, `bans`; read and dismiss `reports`; read `configMeta`, `configLog`, `bans` and the `admins` list |
| `worker.js` | delete anybody's shared replay; watch any (the board's read rule lets an admin through); get `x-replay-admin` when watching one, so the player offers **Remove** and **Remove and ban** |
| `js/admins.js` | nothing: it only decides who is *shown* the buttons (`js/daily-net.js`) and who gets past the admin page's front door |

**Before the new rules are published** nothing changes. The old rules hard-code the owner's uid;
the Worker reads `admins/<uid>`, is refused, and falls back to `ADMIN_UIDS` in `wrangler.jsonc`;
the app is refused too and falls back to `LEGACY_ADMIN_UIDS` in `js/admins.js`. Both fallbacks
apply only to a *refused* read: once the rules know `admins/`, an answer of "not there" is final,
and `ADMIN_UIDS` matters again only if the rules are ever rolled back.

The gold badge on the owner's chat messages goes by the owner's uid (`OWNER_UID` in
`js/ownercard.js`). It is cosmetic, like the name match on the boards, and is not an admin check.

---

## 3. Settings

```
config/<section>/<key>   public read; written only by an admin, only together with its
                         log entry (§7), and only with a value of its type, inside its range
```

`js/config-table.js` is the one list of settings: `CONFIG`, a section per feature, each key with
its type, its **default** (the value the code used before there was a setting), its range, and
where it is enforced. Everything else is made from it:

- **The app** reads a setting with `getConfig(section, key)` (`js/config.js`): the stored value,
  clipped to its range, or the default when there is none, it is the wrong type, or the database
  could not be reached.
- **The Worker** imports the same table for `config/replays` (§4).
- **The rules**: `node tools/config-rules.mjs` writes the `config` block of `firebase.rules.json`
  from the table, one rule per key with its type and range, so the database refuses anything
  outside it too. `test.html` fails if the committed file and the table disagree.
- **The admin page** draws its forms from it: a switch, a number box with its range shown (in
  MB where the setting is bytes), or a text field with a character count.
- **This file**: the table below.

**Reading it costs no connection.** The Firebase project is on the Spark plan, 100 connections at
once ([RACE.md](RACE.md), "Cost"), and a setting that changes a few times a week is not worth one.
The app makes one plain REST `fetch` of `/config.json` when a page loads (`loadConfig()`, in
`main.js`'s `wireConfig`), keeps it in `localStorage` for five minutes, and asks again when a tab
comes back into view or every half hour while it is in view. A change therefore reaches an open
tab within five minutes of it being looked at. If the fetch fails, the last copy or the defaults
stay in use and nothing breaks. The database rules read `config/` themselves, so a switch that the
rules enforce takes effect at once, whatever any tab has cached.

### Every setting

| Setting | Type | Default | Range | Enforced by | What it does |
|---|---|---|---|---|---|
| `replays.enabled` | switch | on | | Worker | Off: no sharing and no watching. The clips stay in R2 and come back when it is on |
| `replays.message` | text | empty | 200 characters | app | Shown where **Share replay** would be while off |
| `replays.maxPerDay` | whole number | 1000 | 0 to **1000** | Worker | The first this many shares of the day, all events together |
| `replays.maxClipBytes` | MB | 10 | 1 to **10** | Worker (and the app's encoder) | The biggest clip; the copy is encoded to fit |
| `replays.dayBudgetBytes` | MB | 1024 | 10 to **1024** | Worker | Space for the whole day, all events together |
| `replays.keepDays` | days | 7 | 1 to **7** | Worker (and the app's ▶) | How long after its day a clip can be watched |
| `sotdChat.enabled` | switch | on | | rules | Off: nobody can post in the day's chat. Reading and deleting carry on |
| `sotdChat.message` | text | empty | 200 characters | app | Shown in place of the box you type in |
| `sotdChat.gapMs` | ms | 1500 | **1500** to 600000 | rules | Least time between two messages from one account |
| `sotdChat.maxLen` | characters | 200 | 20 to **200** | rules | Longest message |
| `race.enabled` | switch | on | | rules | Off: no new race rooms. Rooms already open carry on |
| `race.message` | text | empty | 200 characters | app | Shown in the race panel, and as the toast when a room cannot be made |
| `raceChat.enabled` | switch | on | | rules | Off: nobody can post in any race room's chat |
| `raceChat.message` | text | empty | 200 characters | app | Shown in place of the box you type in |
| `raceChat.gapMs` | ms | 500 | **500** to 600000 | rules | Least time between two messages from one account (new: there was no server limit before) |
| `raceChat.maxLen` | characters | 200 | 20 to **200** | rules | Longest message |
| `app.minVersion` | whole number | 0 | 0 to this deploy's version | app | Tabs older than this reload once they are idle (§4) |
| `sandbox.*` | switch, number, text | off, 5, empty | | nothing | Nothing. For trying the page |

The bold end of each range is the **ceiling**: the side that would cost money, storage, or let
abuse through faster, pinned at the value the code used before.

### Ceilings

The limits that keep the bills at zero stay in the code as hard ceilings, and a setting may
only go *below* them:

| Ceiling | Where it lives | The setting under it |
|---|---|---|
| 10 MB a clip | `CLIP_MAX` in `wrangler.jsonc`, and in `sotd-replays.js` | `replays.maxClipBytes` |
| 1 GB a day | `DAY_BUDGET` in `wrangler.jsonc` | `replays.dayBudgetBytes` |
| 1000 clips a day | `PER_DAY` in `worker.js` (one page of R2's `list`) | `replays.maxPerDay` |
| 7 days after the day | `KEEP_DAYS` in `worker.js` (the bucket's lifecycle rule deletes at 8) | `replays.keepDays` |
| Workers Free | `wrangler.jsonc`, the account | none: no setting touches the plan |

Each is enforced three times. The table's range ends at the ceiling, the rules refuse a stored
value past it, and the Worker clips again with `min(setting, ceiling)`, so even a value put
straight into the database from the console (which skips the rules) cannot raise a limit. That
last case is tested: `maxClipBytes` stored as 20 MB still refuses an 11 MB clip. Raising a
ceiling is a code change and a conversation, never a setting.

### Adding a setting

1. Add it to `CONFIG` in `js/config-table.js`, with today's value as its default and the
   ceiling at the end of its range that costs more. Say where it is enforced (`where`).
2. `node tools/config-rules.mjs` rewrites the rules block.
3. Use `getConfig()` where the old constant was used. Anything about money or abuse must also be
   enforced by `firebase.rules.json` or `worker.js`: a setting only the app reads protects nothing.
4. Spanish for its label in `locales/es.js` (`test.html` checks), a row in the table above, and
   publish the rules.

---

## 4. The safety switches

![Switching shared replays off with a message, the review before saving, and the Bans tab](docs/screenshots/admin-safety.webp)

Each switch has a **message** beside it, shown to people while it is off ("Race is down for
maintenance, back at 6 pm"). Empty, they see a plain default. Turning a switch off never touches
the timer, a solve, or a time already on a board.

### Shared replays (the Worker)

`worker.js` reads `config/replays` over REST, with no token (it is public), and keeps it for a
minute (`CONFIG_TTL_MS`; the dev rig makes that 1.5 s). The order of a share
(DAILY.md §8) becomes:

1. path and day → **switched on?** (`503 off`, with the message) → headers, and the clip under
   `min(maxClipBytes, CLIP_MAX)` (`413`) → the body → a Google account with a result →
   **not banned** (`403 banned`, §5)
2. **the claim**: write-once, this account's one share for the event today
3. the day's count entry (`replayDay/`, below)
4. `list` the day → **fewer than `min(maxPerDay, 1000)` clips** (`429 slots-full`,
   *Today's replay slots are full*) → under `min(dayBudgetBytes, DAY_BUDGET)` (`507 full`)
5. `put`, then the flag

Watching asks the switch too (`503 off`), and `keepDays` (`410`). Deleting never does: an admin
can always take a clip down.

**A full day costs the share.** The claim is written before the count and the budget are checked
(steps 2 and 4). That order is what bounds R2's writes: nothing reaches R2 without a write-once
claim, so a flood of uploads cannot run up Class A operations. The price is that somebody turned
away because the day is full has used their one share for that event that day. So the app checks
first: before encoding anything it reads the day's count, one entry per claim under
`replayDay/<dayKey>/<event>/<uid>` (written by the Worker after the claim, readable by anybody
signed in, never deleted except by the sweep of days older than yesterday), and says *Today's
replay slots are full* without spending anything. The count is all events together, the same as
the Worker's. Only two shares racing for the last slot can still be turned away after their claim.

The app hides **Share replay** when replays are off or the day is full, and says why in its
place. The ▶ on the boards goes while they are off.

### The day's chat and race chat (the rules)

The rules read `config/sotdChat/*` and `config/raceChat/*` directly, with today's numbers when
the node is missing:

- `enabled: false` refuses every new message. Reading carries on, and deletes still work.
- `maxLen` caps the text (200 without it).
- `gapMs` is the time `last/<uid>` (SOTD) or `chatLast/<uid>` (race) must be behind `now` before
  a new message: 1500 ms and 500 ms without it, and those are also the floors. The app waits half
  a second longer than the rule, so a fast connection after a slow one is not refused.

**Race chat has a rate limit now.** It had none on the server (only `CHAT_COOLDOWN_MS`, 700 ms, in
the client), and anonymous accounts can post. A message must arrive in the same update as
`rooms/<id>/chatLast/<uid>` set to the server's `now`, like the day's chat. A client on rules from
before this sends the message alone, which those rules accept; a client that has seen the new
shape work tries it first, and the other once if refused, so a tab open while the rules are
published keeps talking.

While off, the box you type in gives way to the message.

### Race rooms (the rules)

`race.enabled: false` refuses a room's `meta` when it does not exist yet: no new rooms. Rooms
already open carry on (their next rounds, their phase, people joining by code). The race panel
says so under **Create a room**, and pressing it, or following an invite to a room that does not
exist, toasts the message. Local mode (other tabs of your own browser) is not affected.

### A new version (the app)

`js/version.js` has `APP_VERSION`, the same number as `?v=` in `index.html`, bumped with it on
every deploy (`test.html` checks). When `app.minVersion` is higher, a tab is running a deploy you
have retired. It says *A new version is ready — reloading* and reloads, once nothing is going on:
the timer is idle (never during a solve or inspection), no panel is open, the tab is not in a race
room or the SOTD window, and nothing is being typed. Before reloading it asks the service worker
to drop its cache, so the reload cannot come back up on the same old files.

Today a JavaScript-only deploy can take up to 3 days to reach somebody (`MAX_AGE` in `sw.js`).
With this, raise `minVersion` to the new deploy's number and every open tab moves within minutes
of being looked at. It reloads at most once per value per tab, so a typo costs one reload, never
a loop, and the admin page refuses a value above its own version (the page is never cached, so
its version is the deployed one).

---

## 5. Bans

```
bans/<uid>: { at, by, reason, name?, until? }   written by an admin; readable by admins, and by the account itself
```

A banned account cannot post in either chat, share a replay, or put a time or a note on the
Scramble of the Day board. The timer, and the account's own synced solves, are untouched.
Without `until` it lasts until an admin lifts it; with one, it ends by itself (nothing has to
delete it).

| Where | What it stops |
|---|---|
| `firebase.rules.json` | `daily/…/chat/m/<id>` (post), `results/<uid>` (submit), `results/<uid>/note`, `replayClaim/<uid>`, `rooms/…/chat/<id>` |
| `worker.js` | `PUT /replay/…`: `403 banned`, before the claim, so nothing is spent |
| the app | says why instead of offering it: the window's scramble line, the chat box, the note field, Share replay |

**Banning.** In the timer, an admin's delete on somebody's SOTD chat message, the × on their board
row, and **⋯** on their shared replay each offer a second choice, *Delete and ban* or *Remove and
ban*, never the default. The reason is filled in from what was removed. On the admin page, the
**Bans** tab lists every ban with **Unban**, and can ban by uid with a reason and a length (until
unbanned, a day, a week, 30 days). A ban is not a setting, so it is not in the change log; the
record itself says who made it and when.

**Race accounts are throwaways.** A ban on an anonymous race account lasts only as long as that
tab's account, so it is little use against somebody determined. The rules apply it all the same.

---

## 6. Moderation

![The Moderate tab: reports, every chat of the day, flagged times, and a shared replay being watched](docs/screenshots/admin-moderation.webp)

The **Moderate** tab is four views over today, read live on the admin page's one connection.
An admin reads all of it without having done the scramble: the read rules on a day's `results`
and `chat` let an admin through, and `rooms` is readable by admins as a whole.

| View | What is in it | What you can do |
|---|---|---|
| **Reports** | open reports, one card per item, however many people reported it | **Dismiss** (the reports go, the item stays), **Delete** it (the reports go too), **Ban** its author |
| **Chats** | the newest 25 messages of every event's SOTD room today, and of every race room made in the last day, newest first | **Delete**, **Ban** |
| **Suspect** | today's SOTD times and recent race times flagged ⚑ when they were sent | **Remove time**, **Ban** |
| **Replays** | today's shared replays | **Watch** (through the Worker, like anybody), **Remove**, **Ban** |

**Delete** asks first, saying what will happen, and offers *…and ban* beside it. Removing a SOTD
time is the same removal as the × on the board (DAILY.md §10): the person gets the backup
scramble, or is done for the day if it was the backup, and the clip goes too. Removing a replay
deletes the clip through the Worker and clears the row's flag, so the ▶ goes for everybody.
Removing a race time takes it off that round's board; the racer could submit for the round
again, which is fine for rooms that are not a competition. Race rooms are found by
`meta/createdAt` (indexed in the rules) from the last day; **Look again for race rooms** asks
again, since rooms are never cleared out of the database and are not watched as a whole.

### Reporting

```
reports/<pushId>              { by, at, kind: 'chat' | 'raceChat' | 'replay' | 'result', path, text? }
reportOnce/<uid>/<kind|path>  the report's id: one per account per item, readable by its owner
```

A **⚑** sits beside somebody else's message in the day's chat (hover, or always faintly on a
touch screen), and beside a race chat message when this browser is signed in with Google. A
shared replay has **Report this replay** under the player's **⋯**. Each asks first, then says
*Reported. An admin will look at it.*, or *You have already reported that*.

The rules ask that the reporter is a Google account and not banned (race mode's anonymous
accounts cannot report, which is why the race ⚑ needs the timer's own sign-in), that `path` has
the shape its `kind` says and exists (a replay report needs the row's `replay` flag), that `by`
and `at` are the reporter and the server's clock, and that the matching `reportOnce` entry is in
the same update. That entry is write-once and never deleted, so a dismissed report cannot be
filed again by the same person. Reports are readable and deletable by admins only. `result` is
accepted by the rules for a board row, but nothing in the app offers it yet: a flagged time is
already in **Suspect**.

## 7. The change log

```
configLog/<pushId>         { uid, at, path, from?, to?, undo? }   admins only; written once, never edited
configMeta/<section>/<key> { at, by, log }                        admins only; points at the entry
```

Every Save is **one multi-path update**: per setting, the value, its `configMeta` pointer and its
`configLog` entry. The rules chain the three together, so a setting cannot change, from the page
or from anywhere else, without a true entry:

- a `config` value may be written (or deleted) only if its `configMeta/<section>/<key>/at` is
  `now`, i.e. written in the same update;
- that pointer is valid only if the entry it names is in the same update (`at` is `now`) and
  is about the same setting;
- the entry is valid only if its `to` is the value now stored (absent when it was deleted), its
  `from` is the value that was stored before (absent when there was none), its `uid` is yours,
  and the pointer names it back.

So `from` and `to` are the database's own before and after, not what a page believed them to be.
A page that last heard an old value gets its Save refused (*If somebody changed it a moment ago,
check it and save again*), and nothing half-lands. An entry cannot be edited or deleted, even by
an admin. Each is about 150 bytes, and the page keeps the newest 200 live. (The Firebase console
writes past all of this, as it does every rule.)

**Undo** writes the entry's `from` back (or deletes the value, if it was on its default before),
as a new change with its own entry and `undo` naming the one it undoes. If the setting has been
changed again since, the page says so first. An entry whose `from` is already the value has
nothing to undo, and its button is off.

**Use default** deletes the stored value, so the setting follows its built-in default again,
including a future change to that default. Setting the same number by hand would pin it instead.

---

## 8. The page

| File | What it is |
|---|---|
| `admin.html` | The page, served at `/admin` (`html_handling: auto-trailing-slash` in `wrangler.jsonc`) |
| `js/admin.js` | Sign-in, the front door, the forms, review, save, bans, the log, Undo |
| `js/admin-mod.js` | The Moderate tab (§6) |
| `js/moderation.js` | Reports and the SOTD removal, shared by the app and the page |
| `css/admin.css` | Its look: only the theme tokens from `css/tokens.css`, nothing from the timer's own CSS |
| `admin.webmanifest`, `assets/admin-*.png` | Home-screen install: start URL `/admin`, its own name and icon |
| `js/config-table.js` | The settings table, pure enough for the Worker to bundle |
| `js/config.js` | `getConfig()` and `loadConfig()`, the app's live copy |
| `js/config-rules.js`, `tools/config-rules.mjs` | The `config` rules, made from the table |
| `js/admins.js` | *Am I an admin?*, and bans, for the app and this page |
| `js/version.js` | `APP_VERSION`, for `app.minVersion` |
| `tools/verify-admin-rules.mjs` | `node` check of admins, config and the log against the database emulator |
| `tools/verify-safety-rules.mjs` | `node` check of the switches, bans and the replay count |
| `tools/verify-moderation-rules.mjs` | `node` check of reports and of an admin reading and taking down |

Phone first: four tabs (Settings, Moderate, Bans, Change log); a list of sections, each opening a form;
edits collect in a bar at the foot (*3 unsaved changes · Discard · Review*); **Review** lists each
change as *from → to* before anything is written. A value outside its range is marked on its row
and Review stays off. Light or dark follows the phone (the timer's Paper and Nebula themes).

What a visitor sees depends only on the database's answer: signed out, a sign-in button; signed
in but not an admin, *This page is for the site's admins* and nothing else; the owner on rules
from before this page, *Publish the rules first*.

**Never from a cache.** `sw.js` does not answer `/admin`, its manifest, or anything the page
loads (it checks the requesting page) from its cache, and stores none of it, so the page is
always the deployed one. It needs a connection anyway. A link out of it to the timer is still
served offline as usual.

**Connections.** The page uses live listeners (on `config`, `configMeta`, `bans`, the log,
`reports`, and today's boards and chats): one connection per admin with it open. Nobody else
gets that far.

---

## 9. Until firebase.rules.json is republished

Everything keeps working as it did, on the defaults:

- **Replays**: the Worker reads `config/replays`, is refused, and uses the defaults, which are the
  old constants. Bans and the day's count are refused too: nobody is banned, and the app's count
  reads nothing, so it never stops a share. Sharing and watching are exactly as before.
- **The chats**: the old rules know nothing about `config`, so no switch applies. Race chat sends
  each message alone, the old way, and it lands.
- **Race rooms**: the app reads `race.enabled` as on (the default), and the old rules create rooms
  as before.
- **The app's settings**: `config.json` is refused, which reads as "nothing set": the defaults,
  and no reload.
- **The admin page**: the owner sees *Publish the rules first*, everybody else the admins-only line.

On older rules than the page's, the parts that need newer ones say so and the rest works:
**Bans** and **Reports** ask for the newer rules, **Chats** lists only what the admin could
already read, and the app's ⚑ is refused with *Couldn't send the report*.

---

## 10. Testing it

- `node tools/verify-admin-rules.mjs`: 82 checks against the database emulator, in a namespace
  of its own. Every write four ways (an admin; a signed-in Google account that is not one; an
  anonymous account listed under `admins/` by mistake; signed out), the change log's chain
  (a value without its pointer, a pointer without its entry, an entry with a wrong `from` or
  `to`, a client clock, two settings sharing one entry), every number setting at its floor and
  past its ceiling, and the uid the old rules hard-coded having no powers unless `admins/`
  lists it.
- `node tools/verify-safety-rules.mjs`: 67 checks. Both chats with no config (today's numbers),
  then with each switch, gap and length; bans on every write they stop, with and without an end
  date, and who may read and write them; race rooms switched off; race chat's new `chatLast`; the
  replay count entries and their sweep.
- `node tools/verify-moderation-rules.mjs`: 52 checks. An admin reading the day's chat and board
  and listing recent rooms, and nobody else; who may delete a race message, a race time or a
  replay flag; every way a report can be wrong (anonymous, banned, the wrong shape for its kind, a
  path that does not exist, no `reportOnce`, one naming another report, somebody else's name, a
  client clock), one per account per item even after a dismissal, and who reads and deletes them.
- `node tools/verify-sotd-chat-rules.mjs` and `node tools/verify-sotd-remove-rules.mjs` seed
  `admins/` the way the console would, and still pass.
- `node tools/config-rules.mjs --check`, and `test.html`'s *admin console* section (the rules
  match the table, `getConfig` clipping, `APP_VERSION` against `?v=`, the replay ceilings, bans
  ending, every string's Spanish).
- In the browser: `node tools/sotd-replay-dev.mjs`, then `http://localhost:8787/admin?emu=1`,
  and **Admin** in the fake account chooser. Any other account gets the admins-only line.
  `node tools/sotd-replay-dev.mjs rules pre-admin` (or `pre-safety`) puts the emulator on the
  rules from before this page (or before its switches), and `rules new` back. `?emu=1` points
  race mode at the emulators too, so a local race test never reaches the real project.
