/* Shared SOTD replays, run locally with nothing real touched.
       node tools/sotd-replay-dev.mjs            start everything, print the URL
       node tools/sotd-replay-dev.mjs --reset    wipe the local clips first (emulator data never outlives a restart)
       node tools/sotd-replay-dev.mjs --old-rules        start with the rules from before replays
       node tools/sotd-replay-dev.mjs --budget 3000000   a small DAY_BUDGET (bytes), for the "full" case
       node tools/sotd-replay-dev.mjs rules old|new      swap the rules on the running emulator
       node tools/sotd-replay-dev.mjs counts             R2 puts / lists / gets / deletes so far

   What runs: the Firebase Realtime Database and Auth emulators (firebase-tools
   13, Java 11+), and `wrangler dev` with worker.js and R2 simulated on disk.
   Open the printed URL: ?emu=1 points the app at the emulators (sync-auth.js,
   localhost only), and sign-in is the emulator's fake Google account chooser.
   State (the clips, logs, and firebase-tools and wrangler, installed on the
   first run, a minute or two) lives in %LOCALAPPDATA%\tagda-sotd-dev, or
   ~/.cache/tagda-sotd-dev; SOTD_DEV_STATE moves it. */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/* Outside the repo on purpose: the repo is wrangler's asset directory, and it
   reloads on every file written under it, logs included. */
const STATE = process.env.SOTD_DEV_STATE || join(process.env.LOCALAPPDATA || join(homedir(), '.cache'), 'tagda-sotd-dev');
const TOOLS = process.env.SOTD_DEV_TOOLS || join(STATE, 'tools');
const NS = 'tagda-timer-default-rtdb';
const RTDB = 'http://127.0.0.1:9000';
const AUTH = 'http://127.0.0.1:9099';
const JAVA_HINT = 'C:\\Program Files\\Siemens\\Install\\JRE\\bin';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, d) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(opt('--port', 8787));

/* ---------------- rules ---------------- */

/* The rules from before replays: the parent of the commit that added
   replayClaim, or HEAD's while that commit is still uncommitted work. */
function oldRules() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  const intro = git('log', '-S', 'replayClaim', '--format=%H', '--reverse', '--', 'firebase.rules.json').trim().split('\n')[0];
  const text = git('show', `${intro ? `${intro}^` : 'HEAD'}:firebase.rules.json`);
  if (text.includes('replayClaim')) throw new Error('could not find the rules from before replays');
  return text;
}
const newRules = () => readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8');

async function loadRules(which) {
  const text = which === 'old' ? oldRules() : newRules();
  const r = await fetch(`${RTDB}/.settings/rules.json?ns=${NS}`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: text,
  });
  if (!r.ok) throw new Error(`loading the ${which} rules failed: ${r.status} ${await r.text()}`);
  console.log(`[dev] ${which === 'old' ? 'OLD rules (from before replays)' : 'the branch\'s rules'} loaded into the emulator`);
}

if (argv[0] === 'rules') {
  await loadRules(argv[1] === 'old' ? 'old' : 'new');
  process.exit(0);
}

if (argv[0] === 'counts') {
  const log = join(STATE, 'wrangler.log');
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const n = {};
  for (const m of text.matchAll(/\{"r2":"(\w+)"/g)) n[m[1]] = (n[m[1]] || 0) + 1;
  console.log(`R2 since this run started: put ${n.put || 0} · list ${n.list || 0} · get ${n.get || 0} · delete ${n.delete || 0}`);
  process.exit(0);
}

/* ---------------- setup ---------------- */

if (flag('--reset')) {
  rmSync(join(STATE, 'r2-state'), { recursive: true, force: true });
  console.log('[dev] wiped the local R2 clips (the emulators always start empty)');
}
mkdirSync(STATE, { recursive: true });

const bin = {
  firebase: join(TOOLS, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'),
  wrangler: join(TOOLS, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
};
if (!existsSync(bin.firebase) || !existsSync(bin.wrangler)) {
  console.log(`[dev] first run: installing firebase-tools@13 and wrangler@4 into ${TOOLS} …`);
  mkdirSync(TOOLS, { recursive: true });
  if (!existsSync(join(TOOLS, 'package.json'))) writeFileSync(join(TOOLS, 'package.json'), '{ "private": true }\n');
  const npm = spawnSync('npm install --no-audit --no-fund firebase-tools@13 wrangler@4',
    { cwd: TOOLS, stdio: 'inherit', shell: true });
  if (npm.status !== 0) { console.error('[dev] npm install failed'); process.exit(1); }
}

// Java for the database emulator: on PATH, or the JRE this machine has.
// Windows spells it Path; a second key spelt PATH would make two of them.
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' };
const PATH_KEY = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
const hasJava = spawnSync('java', ['-version'], { stdio: 'ignore' }).status === 0;
if (!hasJava) {
  if (existsSync(join(JAVA_HINT, 'java.exe'))) env[PATH_KEY] = `${JAVA_HINT}${delimiter}${env[PATH_KEY] || ''}`;
  else { console.error('[dev] the database emulator needs Java 11 or newer on PATH'); process.exit(1); }
}

// A relative rules path: an absolute Windows one gets glued onto the cwd.
writeFileSync(join(STATE, 'database.rules.json'), flag('--old-rules') ? oldRules() : newRules());
writeFileSync(join(STATE, 'firebase.json'), JSON.stringify({
  database: { rules: 'database.rules.json' },
  emulators: {
    database: { host: '127.0.0.1', port: 9000 },
    auth: { host: '127.0.0.1', port: 9099 },
    ui: { enabled: false },
    singleProjectMode: true,
  },
}, null, 2));

// The Worker's local values. Generated every start, so the flags above are all there is to it.
const budget = opt('--budget', '');
const clipMax = opt('--clip-max', '');
writeFileSync(join(ROOT, '.dev.vars'), [
  '# Written by tools/sotd-replay-dev.mjs on every start. Local only (gitignored).',
  `RTDB_URL=${RTDB}`,
  `RTDB_NS=${NS}`,
  budget ? `DAY_BUDGET=${budget}` : '',
  clipMax ? `CLIP_MAX=${clipMax}` : '',
].filter(Boolean).join('\n') + '\n');

/* ---------------- run ---------------- */

const kids = [];
function run(name, args, cwd) {
  const log = createWriteStream(join(STATE, `${name}.log`));
  const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (chunk) => {
    log.write(chunk);
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) console.log(`[${name}] ${line}`);
  };
  p.stdout.on('data', out);
  p.stderr.on('data', out);
  p.on('error', (err) => { console.error(`[${name}] could not start: ${err.message}`); stop(1); });
  p.on('exit', (code) => { console.log(`[${name}] exited (${code})`); stop(1); });
  kids.push(p);
  return p;
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of kids) {
    if (p.exitCode != null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.kill('SIGTERM');
  }
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

async function up(url, what, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  console.error(`[dev] ${what} did not come up`);
  stop(1);
}

run('firebase', [bin.firebase, 'emulators:start', '--only', 'database,auth', '--project', 'tagda-timer'], STATE);
await up(`${RTDB}/.json?ns=${NS}`, 'the database emulator');
await up(`${AUTH}/`, 'the auth emulator');
await loadRules(flag('--old-rules') ? 'old' : 'new');

run('wrangler', [bin.wrangler, 'dev', '--port', String(PORT), '--ip', '127.0.0.1',
  '--persist-to', join(STATE, 'r2-state')], ROOT);
await up(`http://127.0.0.1:${PORT}/`, 'wrangler dev');

console.log(`
  ┌──────────────────────────────────────────────────────────────
  │  Open  http://localhost:${PORT}/?emu=1
  │
  │  Sign in from the SOTD window: the emulator's account chooser
  │  opens, "Add new account" makes a fake Google account.
  │  ${flag('--old-rules') ? 'OLD rules loaded (sharing should say "not switched on yet")' : 'New rules loaded.'}${budget ? `  DAY_BUDGET=${budget}` : ''}
  │
  │  node tools/sotd-replay-dev.mjs rules old|new   swap rules live
  │  node tools/sotd-replay-dev.mjs counts          R2 operations so far
  │  Ctrl+C stops everything. --reset next time wipes the clips.
  └──────────────────────────────────────────────────────────────
`);
