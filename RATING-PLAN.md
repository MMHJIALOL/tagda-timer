# 1v1 rating plan

A rating that belongs to your Google account, goes up when you beat people in random 1v1 and
down when you lose, and that nobody can type in for themselves. The browser never computes it:
the Worker does, as its own account, and the database rules let only that account write it.

Written against `main` at #204. **Phases 1 (the rules and the rater account, #205) and 2
(`js/elo.js` and the Worker's `/rate`) are built**; phases 3–5 are not, so no page asks for a
rating yet. Decided 2026-10-20: K 40 then 20, 20 rated
rounds per pair a day, the opponent's rating visible, leaving mid-round unrated.

---

## 1. What the player sees

- **1v1 card:** each side shows its rating under the name: `1016`. About 15 s after a round
  ends, the change appears next to it (`1016 +16`) and stays until the next one.
- **Find an opponent drawer:** "Your rating 1016 · 23 rated rounds" when signed in.
- **Unrated 1v1s say why**, in the card's status line, once per match:
  - *Sign in to get a rating* (you aren't linked)
  - *{name} isn't signed in, so this 1v1 isn't rated*
  - *Rated rounds with this player are done for today* (the per-pair cap, §4)
  - *Ratings are off right now* (the admin switch)
- Nothing changes for anyone who isn't signed in: the 1v1 plays exactly as now.

## 2. The formula

Standard Elo, the same shape as csTimer's battle (which is Elo, not XP):

```
expected  E = 1 / (1 + 10^((opponent − you) / 400))
result    S = 1 win, 0.5 draw, 0 loss
change      = round(K × (S − E))
```

- Everybody starts at **1000**.
- **K = 40 for your first 20 rated rounds, then 20.** csTimer uses a flat 32, but its rating
  resets every room. A rating that persists needs to settle down once it has found your level,
  and to move quickly before then.
- **Comparing times:** `timeMs`, plus 2000 for `+2`. A DNF loses to any time; two DNFs, or equal
  times to the millisecond, are a draw.
- Lives in `js/elo.js`: a pure module with no imports, so the Worker and the page share it and a
  node check (`js/elo.check.mjs`) can test it.

## 3. Who the rating belongs to

A race seat is anonymous (one per tab), but a 1v1 already links each seat to a Google account
(`rooms/<id>/acct/<seat>/{claim, ok}`, RACE.md §9). The rating is keyed by that **Google uid**.

A round is rated only if:
- the room's `meta/kind` is `duel` and the round's event is `333`;
- both seats have `ok: true`, and the two claims are **different** accounts;
- both results are in, and neither is struck by a moderator;
- neither time is under the floor (3x3: 3 s);
- the 15 s window for improving a penalty has closed for both. The rules let a player change
  `+2` to `none` only for 15 s after `submittedAt`. After that a penalty can only get worse, and
  a worse penalty only hurts the person who adds it. So the rater waits until
  `max(submittedAt) + 15 s` and uses the penalties as they stand then. A penalty added later
  doesn't change a rating that's already done.

## 4. Abuse, honestly

| Attack | What stops it |
|---|---|
| Writing your own rating | Only the rater account can write `ratings/` (rules) |
| Rating a round twice | `rooms/<id>/rated/<round>` is write-once, written in the same atomic update as the ratings |
| Two tabs updating one account at once | Each rating has a version `v`; the rules accept only `v + 1`, so the loser of the race is refused and retries |
| A fresh account to escape a low rating | Allowed (it costs nothing to make a Google account), but it starts at 1000 with a provisional K, so there's little to gain |
| Two of your own accounts farming each other | Same account on both seats: unrated. Different accounts: **20 rated rounds per pair per IST day**, then unrated; admins can reset a rating (phase 4) |
| Fake times | The existing Tier 1 checks (RACE.md §2), the 3 s floor, and a moderator's strike. Strikes after rating are reversed in phase 4 |
| Quitting when you're about to lose | No result, no rating change. This is the hole. Phase 5 decides whether leaving mid-round after starting, once your opponent has submitted, counts as a loss |

## 5. Data

| Path | Written by | Read by | What |
|---|---|---|---|
| `ratings/<g>` | rater | that account, admins, rater | `{ r, n, w, l, d, v, at }`: rating, rated rounds, wins/losses/draws, version, last change |
| `ratingPair/<istDay>/<gA>_<gB>` | rater | rater | rated rounds this pair has played today (gA < gB) |
| `rooms/<id>/rated/<round>` | rater, once | room's players | `{ <seat>: { r, d } }` or `{ skip: reason }` |
| `rooms/<id>/elo/<seat>` | rater | room's players | the seat's current rating, for the card at match start |

Seat uids are what the room sees, never the Google uids, so opponents can't learn each other's
account from the rating.

## 6. The rules (published by hand) — built in phase 1

- A new custom-token account **`tagda-rater`** (`RATER_UID` and `RATER` in `js/config-rules.js`,
  next to `SCHEDULER_UID`), signed in by the Worker with the same service account as the
  scheduler. It's a separate account so its rules grant exactly this and nothing else.
  `raterChecks()` (run by `node tools/config-rules.mjs --check` and test.html) refuses a rules
  file that names the uid without the whole `RATER` expression, custom sign-in included.
- The rater **reads** a room's `acct` (all seats in one request) and a round's `results`.
  `meta`, `players`, `mod` and `rounds/*/info` were already readable by anyone signed in. It
  reads nothing else: not `rtc` (IP addresses), not the list of rooms.
- `ratings/$g`: the rater writes while `duel.rated` is on; an admin writes or deletes any time
  (a reset). Every write is `v === data.v + 1` (`1` when new), `n === w + l + d`, `r` an integer
  from 100 to 4000, `at === now`. For the rater only: `r` moves at most 40 (a new rating starts
  within 40 of 1000) and `n` moves by exactly one, up or down (down is phase 4's reversal).
  Readable by that account, admins and the rater; nobody lists them all.
- `ratingPair/$day/$pair`: the rater, today (IST) only, up by exactly 1, at most 20 and at most
  `duel.ratedPairCap`. An admin may delete a past day. Readable by the rater and admins.
- `rooms/$roomId/rated/$round`: the rater only, once, in a 1v1. `{ at, skip }` or
  `{ at, <seat>: { r, d } }`, `d` within ±40. Readable by the room's players.
- `rooms/$roomId/elo/$seat`: the rater only, in a 1v1, `{ r, n }`. Readable by the room's players.
- `config/duel/rated` (switch, on) and `config/duel/ratedPairCap` (1–20, 20) via the config
  table, so the admin console can switch ratings off or tighten the cap. "Rated 1v1s" is on the
  Live tab's switch list.
- `tools/verify-rating-rules.mjs` checks all of it against the emulator (87 cases).

Everything for one round goes in **one root `PATCH`**: both ratings, the pair counter and the
`rated` marker. The database applies a multi-path update all or nothing, so a refusal anywhere
(a version that moved, a round already rated) writes nothing.

## 7. The Worker: `POST /rate` — built in phase 2

`{ room, round }`, with the seat's ID token as the bearer, like `/turn`. The code is `rate()` in
`worker.js`; the arithmetic and every decision are `js/elo.js`.

1. **Cheap checks first:** `duel.rated` (off: `403 off`), the token, the shape of `room` and
   `round` (a whole number from 1).
2. **Caller is in the room:** a read of `rooms/<room>/rtc` (shallow) with *their* token. As in
   `/turn`, a read the rules allow is the proof. Refused: `401`/`403 not-in-room`.
3. **As the rater** (`customToken()`, shared with the scheduler, kept until five minutes before it
   expires; no `FIREBASE_SERVICE_ACCOUNT`: `503 no-credential`): read `meta` and `acct`
   (not a 1v1: `403 not-a-1v1`), then the round's `info` and `results`, `mod/struck/<round>` and
   `rated/<round>` in parallel. A read the rules refuse means rules from before ratings:
   `503 rules`.
4. Already rated: `200` with what's there. `judgeRound()` then says one of:
   - `none`: one time in, or more than two: `409 not-finished`. Nothing is written; the round may
     never finish (the other player quit).
   - `wait`: a penalty can still improve: `202 { wait }`, ms until `max(submittedAt) + 15.5 s`.
   - `skip`: `event`, `struck`, `unlinked`, `same-account`, `bad-result`, `floor`, or `cap` (the
     pair's count is at the cap). Written once as `rated/<round> = { at, skip }` and returned.
     Unlinked and same-account are decided at once; nothing about them can change.
   - `rate`: read both `ratings/<g>` and today's pair count, build the root `PATCH` with
     `roundUpdate()`, send it. Refused: read `rated/<round>` (somebody else rated it: return that)
     or go round again, three tries in all (`409 busy` after).
5. Answer: `200 { round, at, seats: { <seat>: { r, d } } }` or `200 { round, at, skip }`.

Without `round`: both linked seats' current ratings (1000 and 0 rounds when new) go to
`rooms/<id>/elo/<seat>` and come back as `200 { elo }`, so the card has numbers before the first
round.

**Budget:** a round rated on the first try is 11 subrequests (13 when the settings and the
rater's sign-in aren't cached yet), at most about 24 with all three tries, against
the 50 Workers Free allows. Both clients call it for every round, and the later call is a read
back. A long 1v1 is about one request a minute per player, far inside 100k a day. The database
uses REST, so it costs no simultaneous connections.

**Tested:** `js/elo.check.mjs` (`npm run test:elo`) for the formula and the decisions;
`tools/verify-rate.mjs` end to end against `wrangler dev` and the database and Auth emulators
(36 checks: four asks at once rate a round once, one account rated in two 1v1s at the same moment
lands both, every skip reason, both switches, and old rules).

## 8. The page

- `race.js`: when a 1v1 round settles, call `/rate` at `max(submittedAt) + 15.5 s`, and once
  more on `retryAfterMs`. Either player's call is enough, so the round still gets rated if the
  other one has quit.
- Listen to `rooms/<id>/rated` and `rooms/<id>/elo` (both small) and draw them on the card.
- Read your own `ratings/<g>` with a plain REST request (no listener) for the drawer.
- Strings in `locales/`, a `?v=` bump.

**Known gap:** if both players quit within 15 s of the last round, nobody calls `/rate` and that
round isn't rated. Phase 5's cron backstop closes it.

## 9. Phases

1. **Rules + rater account.** ✅ Built: `RATER_UID`, the paths in §5 and §6, the `duel.rated`
   settings, `tools/verify-rating-rules.mjs`. The owner publishes the rules; nothing uses them
   until phase 2.
2. **`js/elo.js` + `/rate`.** ✅ Built (§7). Node checks for the formula and the rateable/final decisions.
   `wrangler dev` against the emulator: two linked seats, concurrent calls, a version clash,
   the pair cap, a struck round.
3. **The page.** Card, drawer, unrated reasons. Playwright with two seats signed in, Chrome and
   Firefox.
4. **Admin console.** Look up an account's rating, reset it, and reverse a rated round when a
   moderator strikes it (the reversal is another versioned `PATCH`).
5. **Later, each on its own:** a public leaderboard (opt-in name, `.indexOn: r`); a cron backstop
   that rates rounds nobody called `/rate` for; leaving mid-round as a loss; matching by rating
   once there are enough players to choose between; race rooms (csTimer's `K / (players − 1)`).

## 10. Before it can go live (owner)

- The Worker secrets `FIREBASE_SERVICE_ACCOUNT` and `FIREBASE_API_KEY` (the scheduled changes use
  them too). Without them `/rate` answers 503 and every 1v1 stays unrated, as now.
- Publish `firebase.rules.json` after phase 1 merges.

## 11. Decisions (taken 2026-10-20)

- **K:** 40 for your first 20 rated rounds, then 20.
- **Per-pair cap:** 20 rated rounds per pair per day (`duel.ratedPairCap`, which can only go lower).
- **Opponent's rating:** visible on the card.
- **Leaving mid-round:** unrated for now; phase 5 may revisit it.
