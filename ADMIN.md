# The admin console

**tagdatimer.me/admin** is a page for the site's admins: the app's settings, changed from a
phone without touching code, and a log of every change with an **Undo** on each one. Anybody
can open the address; only an account listed under `admins/` in the database gets past the
sign-in, and the database refuses everybody else's writes whatever the page shows them.

It is built in phases, and this is the first: who is an admin, the settings node and its
rules, the change log, and the page. There are no real settings yet (§3): the page has a
**Sandbox** section that nothing reads, to try it with.

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
| `firebase.rules.json` | delete anybody's SOTD chat message; remove a SOTD time (`results`, `removed`, `progress/<uid>/submitted`, `replayClaim`, all in one write, DAILY.md §10); write `config`, `configMeta`, `configLog`; read `configMeta`, `configLog` and the `admins` list |
| `worker.js` | delete anybody's shared replay; get `x-replay-admin` when watching one, so the player offers **Remove** |
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
                         log entry (§4), and only with a value of its type, inside its range
```

`js/config.js` is the one list of settings: `CONFIG`, a section per feature, each key with its
type, its **default** (the value the code used before there was a setting), and for numbers a
range whose top is the **ceiling**. Everything else is made from it:

- **The app** reads a setting with `getConfig(section, key)`: the stored value, clipped to its
  range, or the default when there is none, it is the wrong type, or the database could not be
  reached. A typo can never take a number past its ceiling, because the code uses
  `min(setting, ceiling)` whatever the database says.
- **The rules**: `node tools/config-rules.mjs` writes the `config` block of `firebase.rules.json`
  from the table, one rule per key with its type and range, so the database refuses anything
  past a ceiling too. `test.html` fails if the committed file and the table disagree.
- **The admin page** draws its forms from it: a switch, a number box with its range shown, or a
  text field with a character count.
- **This file**: the table below.

**Reading it costs no connection.** The Firebase project is on the Spark plan, 100 connections at
once ([RACE.md](RACE.md), "Cost"), and a setting that changes a few times a week is not worth one.
`loadConfig()` makes one plain REST `fetch` of `/config.json` and keeps it in `localStorage` for
five minutes (`CACHE_MS`); a change reaches a visitor on their next page load after that. If the
fetch fails, the last copy or the defaults stay in use and nothing breaks. Nothing in the app calls
it yet: the Sandbox is the only section, and nothing reads it. The first real settings bring the
call with them.

### Every setting

| Setting | Type | Default | Range | Enforced by | What it does |
|---|---|---|---|---|---|
| `sandbox.on` | switch | off | | nothing | Nothing. For trying the page |
| `sandbox.n` | whole number | 5 | 0 to 10 | nothing | Nothing. Shows a number box and its range |
| `sandbox.text` | text | empty | 80 characters | nothing | Nothing. Shows a text field |

### Ceilings

The limits that keep the bills at zero stay in the code as hard ceilings: `CLIP_MAX` 10 MB a
clip, `DAY_BUDGET` 1 GB a day, 1000 clips a day (one page of R2's `list`), and the Workers Free
plan ([DAILY.md](DAILY.md) §8, "The money rule"). A setting may only go *below* one of these: its
`max` in the table is the ceiling itself, the rules refuse anything above it, and the code clips
to it again. Raising a ceiling is a code change and a conversation, never a setting.

### Adding a setting

1. Add it to `CONFIG` in `js/config.js`, with today's value as its default and the ceiling as
   its `max`. Say where it is enforced (`where`: `rules`, `worker` or `app`).
2. `node tools/config-rules.mjs` rewrites the rules block.
3. Use `getConfig()` where the old constant was used. Anything about money or abuse must also be
   enforced by `firebase.rules.json` or `worker.js`: a setting only the app reads protects nothing.
4. Spanish for its label in `locales/es.js` (`test.html` checks), a row in the table above, and
   publish the rules.

---

## 4. The change log

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
an admin. Each is about 150 bytes, and the page keeps the newest 200 live.

**Undo** writes the entry's `from` back (or deletes the value, if it was on its default before),
as a new change with its own entry and `undo` naming the one it undoes. If the setting has been
changed again since, the page says so first. An entry whose `from` is already the value has
nothing to undo, and its button is off.

**Use default** deletes the stored value, so the setting follows its built-in default again,
including a future change to that default. Setting the same number by hand would pin it instead.

---

## 5. The page

| File | What it is |
|---|---|
| `admin.html` | The page, served at `/admin` (`html_handling: auto-trailing-slash` in `wrangler.jsonc`) |
| `js/admin.js` | Sign-in, the front door, the forms, review, save, the log, Undo |
| `css/admin.css` | Its look: only the theme tokens from `css/tokens.css`, nothing from the timer's own CSS |
| `admin.webmanifest`, `assets/admin-*.png` | Home-screen install: start URL `/admin`, its own name and icon |
| `js/config.js` | The settings table, `getConfig()` and `loadConfig()` |
| `js/config-rules.js`, `tools/config-rules.mjs` | The `config` rules, made from the table |
| `js/admins.js` | *Am I an admin?*, for the app and this page |
| `tools/verify-admin-rules.mjs` | `node` check of every rule above against the database emulator |

Phone first: a list of sections, each opening a form; edits collect in a bar at the foot
(*3 unsaved changes · Discard · Review*); **Review** lists each change as *from → to* before
anything is written. A value outside its range is marked on its row and Review stays off. Light or
dark follows the phone (the timer's Paper and Nebula themes).

What a visitor sees depends only on the database's answer: signed out, a sign-in button; signed
in but not an admin, *This page is for the site's admins* and nothing else; the owner on rules
from before this page, *Publish the rules first*.

**Never from a cache.** `sw.js` does not answer `/admin`, its manifest, or anything the page
loads (it checks the requesting page) from its cache, and stores none of it, so the page is
always the deployed one. It needs a connection anyway. A link out of it to the timer is still
served offline as usual.

**Connections.** The page uses live listeners (on `config`, `configMeta` and the log): one
connection per admin with it open. Nobody else gets that far.

---

## 6. Testing it

- `node tools/verify-admin-rules.mjs`: 72 checks against the database emulator, in a namespace
  of its own. Every write four ways (an admin; a signed-in Google account that is not one; an
  anonymous account listed under `admins/` by mistake; signed out), the change log's chain
  (a value without its pointer, a pointer without its entry, an entry with a wrong `from` or
  `to`, a client clock, two settings sharing one entry), every ceiling, and the uid the old
  rules hard-coded having no powers unless `admins/` lists it.
- `node tools/verify-sotd-chat-rules.mjs` and `node tools/verify-sotd-remove-rules.mjs` seed
  `admins/` the way the console would, and still pass.
- `node tools/config-rules.mjs --check`, and `test.html`'s *admin console* section.
- In the browser: `node tools/sotd-replay-dev.mjs`, then `http://localhost:8787/admin?emu=1`,
  and **Admin** in the fake account chooser. Any other account gets the admins-only line.
  `node tools/sotd-replay-dev.mjs rules pre-admin` puts the emulator on the rules from before
  this page, and `rules new` back.
