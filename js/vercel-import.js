import { t } from './i18n.js';
import { el } from './util.js';
import { exportAll, importAll, KV } from './db.js';

const OLD_ORIGIN = 'https://tagdatimer.vercel.app';

// Keep current records when an old backup contains the same IDs. In particular,
// importing twice must not restore an old penalty or rename an existing session.
export async function mergeVercelData(data, includeSettings = false) {
  if (data?.app !== 'tagdatimer' || !Array.isArray(data.solves)) throw new Error(t('Not a Tagda Timer backup'));
  const current = await exportAll();
  const merged = { ...data };
  for (const [store, key] of [['solves', 'id'], ['sessions', 'id'], ['letterPairs', 'pair'], ['gear', 'id'], ['gearLog', 'id']]) {
    const mine = new Map((current[store] || []).map(row => [row[key], row]));
    merged[store] = (data[store] || []).map(row => mine.get(row[key]) || row);
  }
  const ids = new Set(current.solves.map(s => s.id));
  const added = data.solves.filter(s => !ids.has(s.id)).length;
  await importAll(merged, { merge: true });
  if (includeSettings && data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)) {
    await KV.set('settings', data.settings);
  }
  return added;
}

export function buildVercelImport() {
  const status = el('div', { class: 'sub', role: 'status', 'aria-live': 'polite', text: t('Use the same browser and profile you used on the old site. Existing solves are kept.') });
  const settings = el('input', { type: 'checkbox', 'aria-label': t('Include old settings') });
  const button = el('button', { class: 'ghost-btn', text: t('Import from .vercel.app'), onclick: start });
  const actions = el('div', { class: 'lbl' }, button,
    el('label', { class: 'sub' }, settings, t('Include old settings')));
  const row = el('div', { class: 'row' },
    el('div', { class: 'lbl' }, el('span', { text: t('Old Vercel data') }), status), actions);

  function start() {
    const nonce = crypto.randomUUID();
    const popup = window.open(`${OLD_ORIGIN}/import-from-vercel?request=${nonce}`, '_blank');
    if (!popup) {
      status.textContent = t('Allow pop-ups for this site, then try again.');
      return;
    }
    button.disabled = true;
    const includeSettings = settings.checked;
    status.textContent = t('Reading your old data…');
    let busy = false;
    const cleanup = () => {
      clearTimeout(timeout); clearInterval(closed);
      window.removeEventListener('message', receive);
      button.disabled = false;
    };
    const fail = message => { cleanup(); status.textContent = message; };
    const timeout = setTimeout(() => fail(t('The old site did not respond. Keep its tab open and try again.')), 60000);
    const closed = setInterval(() => {
      if (!busy && popup.closed) fail(t('Import cancelled. Click import to try again.'));
    }, 500);
    async function receive(event) {
      if (event.source !== popup || event.origin !== OLD_ORIGIN || event.data?.request !== nonce || busy) return;
      if (event.data.type === 'tagda-export-ready') {
        popup.postMessage({ type: 'tagda-export-request', request: nonce }, OLD_ORIGIN);
      } else if (event.data.type === 'tagda-export-error') {
        fail(t('Could not read the old data. Check that tab and try again.'));
      } else if (event.data.type === 'tagda-export-data') {
        busy = true;
        clearTimeout(timeout); clearInterval(closed);
        status.textContent = t('Importing your solves…');
        try {
          const data = event.data.data;
          const hasData = data?.solves?.length || data?.sessions?.length || data?.letterPairs?.length || data?.gear?.length
            || Object.keys(data?.settings || {}).length || Object.keys(data?.learn || {}).length;
          if (!hasData) {
            cleanup(); popup.close();
            status.textContent = t('No saved data found in this browser on the old site. Try the browser and profile you used before.');
            return;
          }
          const count = await mergeVercelData(data, includeSettings);
          cleanup(); popup.close();
          try { sessionStorage.setItem('tdt-moved-count', String(count)); } catch { /* Import is already committed. */ }
          location.reload();
        } catch (error) {
          fail(t('Import failed: {err}', { err: error.message }));
        }
      }
    }
    window.addEventListener('message', receive);
  }
  return row;
}
