import { t } from './i18n.js';
import { el, fmtDate, download } from './util.js';
import { getLocalStatus, onLocalStatus, retryLocalWrites, exportRecovery, exportAll, LocalMetadata } from './db.js';
import { getSyncStatus, onSyncStatus, retrySync } from './sync.js';
import { currentUser, signIn } from './sync-auth.js';
import { toast } from './toast.js';
import { telemetryOn, setTelemetry } from './health.js';
import { supportSection } from './support.js';

const EXPORT_KEY = '_dataHealth.export';
const exportListeners = new Set();
let exporting = false;

export function localCopy(status = getLocalStatus()) {
  return t(({ saved: 'Saved on this device', saving: 'Saving on this device…',
    error: 'Could not save on this device', checking: 'Checking local storage…',
    unknown: 'Local save status unavailable' })[status.state]);
}
export function cloudCopy(status = getSyncStatus()) {
  const messages = {
    'signed-out': 'Cloud sync off', starting: 'Connecting to cloud sync…',
    'up-to-date': 'Cloud sync up to date',
    'pending-offline': '{n} changes saved here, waiting for connection',
    paused: '{n} changes saved here; cloud sync is paused for maintenance',
    syncing: 'Syncing {n} changes…', retrying: '{n} changes waiting to sync',
    error: 'Cloud sync needs attention', unknown: 'Cloud sync status unavailable',
  };
  const singular = {
    'pending-offline': '1 change saved here, waiting for connection',
    paused: '1 change saved here; cloud sync is paused for maintenance',
    syncing: 'Syncing 1 change…', retrying: '1 change waiting to sync',
  };
  return t(status.pending === 1 && singular[status.state] || messages[status.state], { n: status.pending });
}

// Both export buttons use this implementation. Anchor clicks prove preparation
// only; the browser may still cancel or decline the download.
export async function prepareBackup({ build = exportAll, startDownload = download, storage = LocalMetadata } = {}) {
  if (exporting) return;
  exporting = true;
  try {
    const data = await build();
    const json = JSON.stringify(data, null, 2);
    startDownload(`tagdatimer-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
    const record = { at: Date.now(), solveCount: data.solves.length };
    try {
      await storage.set(EXPORT_KEY, record);
      for (const fn of exportListeners) fn(record);
    } catch (e) {
      console.warn('[health] export date could not be recorded', e);
      toast('Export prepared; its date could not be recorded', { kind: 'warn' });
      return;
    }
    toast('Export prepared — check your Downloads folder', { kind: 'good' });
  } catch (e) {
    console.warn('[health] export preparation failed', e);
    toast('Could not prepare export — try again', { kind: 'bad' });
  } finally { exporting = false; }
}

export async function storageSnapshot(storage = navigator.storage) {
  const [estimate, persistent] = await Promise.allSettled([
    Promise.resolve().then(() => storage?.estimate ? storage.estimate() : null),
    Promise.resolve().then(() => storage?.persisted ? storage.persisted() : null),
  ]);
  return { estimate: estimate.status === 'fulfilled' ? estimate.value : null,
    persistent: persistent.status === 'fulfilled' ? persistent.value : null };
}
function size(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function buildDataHealthRow(open) {
  const sub = el('span', { class: 'sub' });
  const row = el('div', { class: 'row data-health-row', dataset: { searchLabel: 'Data Health' } },
    el('div', { class: 'lbl' }, el('span', { text: 'Data Health' }), sub),
    el('button', { class: 'ghost-btn', text: 'View details', onclick: open }));
  const render = () => { sub.textContent = `${localCopy()} · ${cloudCopy()}`; };
  const off = [onLocalStatus(render), onSyncStatus(render)];
  return { row, dispose: () => off.forEach(fn => fn()) };
}

/* The heartbeat and error reports (js/health.js, ADMIN.md "Health"), said
   plainly, with this device's switch for both. */
function sends() {
  const box = el('input', { type: 'checkbox' });
  box.checked = telemetryOn();
  box.addEventListener('change', () => {
    setTelemetry(box.checked);
    toast(box.checked ? 'Health reports on for this device' : 'Health reports off for this device');
  });
  return el('div', {},
    el('p', { class: 'sub', text: 'While you are signed in, this timer sends a small health report about once an hour: the app version, your browser family and system (never the full browser string), whether offline mode is on, how many changes are waiting to sync and for how long, and how long scrambles take to make. When something on the page breaks, it sends the error message and where in the code it happened. Never your solves, times, settings or anything you type. Reports are kept for 14 days and only the site’s admins can read them. Once a day it also tells the site the name and picture you already show on the boards, so an admin can find you when you ask for help. And while the page is connected, it says so (your account id, nothing else), so the admins can count connections against the free plan’s limit; that goes the moment you close the page.' }),
    el('label', { class: 'health-toggle' }, box, el('span', { text: 'Send health reports from this device' })));
}

export function buildDataHealth({ back, account }) {
  return body => {
    let disposed = false, backup = null;
    const local = el('p', { class: 'health-value', role: 'status' });
    const localNote = el('p', { class: 'sub' });
    const retryLocal = el('button', { class: 'ghost-btn', text: 'Retry local save', onclick: async () => {
      retryLocal.disabled = true;
      try { await retryLocalWrites(); }
      catch (e) { console.warn('[health] local retry failed', e); }
      finally { if (!disposed) render(); }
    } });
    const recover = el('button', { class: 'ghost-btn', text: 'Export unsaved solves', onclick: () => {
      download('tagdatimer-recovery.json', JSON.stringify(exportRecovery(), null, 2));
      toast('Export prepared — check your Downloads folder', { kind: 'good' });
    } });
    const cloud = el('p', { class: 'health-value', role: 'status' });
    const cloudNote = el('p', { class: 'sub' });
    const synced = el('p', { class: 'sub' });
    const retry = el('button', { class: 'ghost-btn', text: 'Retry now', onclick: async () => {
      retry.disabled = true;
      try { await retrySync(); }
      catch (e) { console.warn('[health] cloud retry failed', e); }
      finally { if (!disposed) render(); }
    } });
    const login = el('button', { class: 'ghost-btn', text: 'Sign in with Google', onclick: () => {
      signIn('google').catch(e => {
        if (!['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e?.code)) toast('Could not sign in — try again', { kind: 'bad' });
      });
    } });
    const openAccount = el('button', { class: 'ghost-btn', text: 'Open account', onclick: account });
    const exportDate = el('p', { class: 'health-value' });
    const usage = el('p', { class: 'health-value', text: 'Checking browser storage…' });
    const persistence = el('p', { class: 'sub' });
    const media = el('p', { class: 'sub' });
    const section = (title, ...nodes) => el('section', { class: 'group health-section' }, el('h3', { text: title }), ...nodes);
    body.append(el('button', { class: 'ghost-btn', text: 'Back to Data controls', onclick: back }),
      section('On this device', local, localNote, el('div', { class: 'health-actions' }, retryLocal, recover)),
      section('Cloud sync', cloud, cloudNote, synced, el('div', { class: 'health-actions' }, retry, login, openAccount)),
      section('Backup file', exportDate, el('button', { class: 'ghost-btn', text: 'Export backup', onclick: prepareBackup }),
        el('p', { class: 'sub', text: 'Check your Downloads folder and keep the file somewhere safe.' })),
      section('Browser storage', usage, persistence, media,
        el('p', { class: 'sub', text: 'Browser estimates for this site include solves, cached app files and any stored media. The allowance is not free disk space.' })),
      section('What Tagda Timer sends', sends()),
      section('Help from the site', supportSection()),
      section('Help', el('p', { class: 'sub', text: 'Local saves keep your solves in this browser. Cloud sync confirms when changes reach your signed-in account. A backup export prepares a file you can keep outside the browser.' }),
        el('button', { class: 'ghost-btn', text: 'Export and import controls', onclick: back })));
    function render() {
      if (disposed) return;
      const l = getLocalStatus(), s = getSyncStatus();
      local.textContent = localCopy(l) + (l.lastWrite ? ' · ' + t('Last successful write {date}', { date: fmtDate(l.lastWrite) }) : '');
      localNote.textContent = l.state === 'error' ? t(l.quotaError
        ? 'Browser storage is full. Export your data, free space, then retry.'
        : 'Some changes could not be saved. Retry or export them before leaving this page.') : '';
      retryLocal.hidden = recover.hidden = !l.unsaved;
      retryLocal.disabled = l.pending > 0;
      cloud.textContent = cloudCopy(s);
      const user = currentUser();
      cloudNote.textContent = s.state === 'signed-out' ? t('Cloud sync is off. Your solves can still be saved on this device.')
        : s.state === 'unknown' && !user ? t('Account status could not be checked. Check your connection and try signing in again.')
        : s.error === 'storage' ? t('Could not record pending cloud changes. Export backup and retry.')
        : ['start', 'permission'].includes(s.error) ? t('Could not connect to your account. Check your connection or open Account to sign in again.')
        : s.state === 'retrying' ? t('The upload has not been acknowledged. Your changes remain queued for retry.')
        : user ? t('Syncing as {email}', { email: user.email || user.displayName || '' }) : '';
      synced.textContent = s.lastSync ? t('Last synced {date} — outbound changes from this device only.', { date: fmtDate(s.lastSync) }) : '';
      retry.hidden = !s.needsAttention; retry.disabled = s.inFlight;
      login.hidden = !!user || !['signed-out', 'unknown'].includes(s.state);
      openAccount.hidden = !user;
      exportDate.textContent = backup ? t('Last export prepared {date}', { date: fmtDate(backup.at) }) : t('No export prepared on this device yet');
    }
    const off = [onLocalStatus(render), onSyncStatus(render)];
    const onExport = record => { backup = record; render(); };
    exportListeners.add(onExport);
    LocalMetadata.get(EXPORT_KEY).then(record => { if (!disposed) { backup = record; render(); } }).catch(() => {});
    storageSnapshot().then(({ estimate, persistent }) => {
      if (disposed) return;
      const valid = Number.isFinite(estimate?.usage) && Number.isFinite(estimate?.quota) && estimate.quota > 0;
      usage.textContent = valid ? t('{used} used of ~{quota} browser allowance', { used: size(estimate.usage), quota: size(estimate.quota) }) : t('Browser storage estimate unavailable');
      if (valid && estimate.usage / estimate.quota >= .9) usage.textContent += ' · ' + t('Storage nearly full — export backup');
      persistence.textContent = t(persistent === true ? 'The browser considers this site’s storage persistent.'
        : persistent === false ? 'The browser may clear local data when space is low. Keep an export backup.' : 'Storage persistence status unavailable');
    });
    import('./replay.js').then(m => m.replayUsage()).then(info => {
      if (!disposed && info.count) media.textContent = t('Local replay videos: {n} · {size}. Video files are excluded from the JSON backup.', { n: info.count, size: size(info.bytes) });
    }).catch(() => {});
    render();
    return () => { disposed = true; off.forEach(fn => fn()); exportListeners.delete(onExport); };
  };
}
