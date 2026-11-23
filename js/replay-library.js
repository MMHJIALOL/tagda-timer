import { t } from './i18n.js';
import { el, fmt, fmtDate, download } from './util.js';
import { listReplays, refreshReplays, openReplay, onReplayChange,
  scanReplayRecovery, readRecoveryRecording, recoverRecording } from './replay.js';

/** All local recordings, including older sessions and clips without solve rows.
    Reading this view never opens a camera or loads video bytes. */
export function buildReplayLibrary(app, back, { recovery = false } = {}) {
  return body => {
    let disposed = false, revision = 0, scanRevision = 0;
    const status = el('p', { class: 'sub', role: 'status' });
    const rows = el('div', { class: 'group', role: 'list', 'aria-label': t('Saved replays') });
    const retry = el('button', { class: 'ghost-btn', text: t('Retry loading'), onclick: () => load() });
    const found = el('p', { class: 'sub', role: 'status' });
    const recoveryRows = el('div', { class: 'group', role: 'list', 'aria-label': t('Recoverable recordings') });
    const scan = el('button', { class: 'ghost-btn', text: t('Find recoverable recordings'), onclick: () => inspect() });
    body.append(el('button', { class: 'ghost-btn', text: t('Back to Camera settings'), onclick: back }),
      el('div', { class: 'group' }, el('h3', { text: t('Recording recovery') }),
        el('p', { class: 'sub', text: t('Checks this browser for unfinished recordings. Surviving footage can be recovered or downloaded. Files already deleted cannot be recreated.') }), scan, found, recoveryRows),
      el('div', { class: 'group' }, el('h3', { text: t('Saved replays') }), status, retry, rows));

    // Inspect the independent journal even when the final replay database is
    // stalled. A scan does not delete, upload, or start the camera.
    async function inspect() {
      const request = ++scanRevision;
      scan.disabled = true; found.textContent = t('Checking recoverable recordings…');
      try {
        const result = await scanReplayRecovery();
        if (disposed || request !== scanRevision) return;
        found.textContent = result.recordings.length
          ? t(result.recordings.length === 1 ? '{n} recording found' : '{n} recordings found', { n: result.recordings.length })
          : result.errors.length ? t('Some recording storage could not be read. Keep this tab open and retry.') : t('No unfinished recordings found.');
        if (result.recordings.length && result.errors.length) found.textContent += ' ' + t('Some recording storage could not be read. Keep this tab open and retry.');
        recoveryRows.replaceChildren(...result.recordings.map(candidate => {
          const complete = candidate.complete && candidate.meta && !candidate.meta.partial;
          const actions = el('div', { class: 'sd-actions' });
          const message = el('span', { class: 'sub', role: 'status' });
          if (complete) actions.append(el('button', { class: 'ghost-btn sm', text: t('Recover replay'), onclick: async event => {
            const button = event.currentTarget; button.disabled = true;
            try { await recoverRecording(candidate); message.textContent = t('Replay recovered'); await load(); await inspect(); }
            catch { message.textContent = t('Could not finish recovery. Your recovery copy is retained; try Download footage.'); button.disabled = false; }
          } }));
          actions.append(el('button', { class: 'ghost-btn sm', text: t('Download footage'), disabled: candidate.active, onclick: async event => {
            const button = event.currentTarget; button.disabled = true;
            try {
              const recording = await readRecoveryRecording(candidate);
              if (!recording?.blob?.size) throw new Error('No footage');
              const ext = /mp4/.test(recording.blob.type) ? 'mp4' : 'webm';
              download(`tagda-recovered-${candidate.meta?.id || candidate.id}${complete ? '' : '-partial'}.${ext}`, recording.blob, recording.blob.type || 'video/webm');
              message.textContent = t('Video prepared — check Downloads. The recovery copy is retained.');
            } catch { message.textContent = t('Could not read this footage. Keep this tab open and retry.'); }
            finally { button.disabled = false; }
          } }));
          return el('div', { class: 'row', role: 'listitem' }, el('div', { class: 'lbl' },
            el('span', { text: candidate.meta ? fmt(candidate.meta.timeMs) : t('Recording without solve details') }),
            el('span', { class: 'sub', text: [fmtDate(candidate.at), candidate.active ? t('Recording in progress')
              : complete ? t('Ready to recover') : t('Partial recording — timing or footage may be incomplete')].join(' · ') }), message), actions);
        }));
      } catch {
        if (!disposed && request === scanRevision) found.textContent = t('Some recording storage could not be read. Keep this tab open and retry.');
      } finally { if (!disposed && request === scanRevision) scan.disabled = false; }
    }

    async function load() {
      const request = ++revision;
      retry.disabled = true;
      status.textContent = t('Checking saved replays…');
      try {
        await refreshReplays();
        const [clips, solves] = await Promise.all([listReplays(),
          Promise.resolve().then(() => app.allSolves ? app.allSolves() : app.solves || [])
            .catch(() => app.solves || [])]);
        if (disposed || request !== revision) return;
        const byId = new Map(solves.map(s => [s.id, s]));
        const sessions = new Map((app.sessions || []).map(s => [s.id, s.name]));
        status.textContent = clips.length ? t('{n} saved replays on this device', { n: clips.length }) : t('No saved replays on this device.');
        rows.replaceChildren(...clips.map(meta => {
          const solve = byId.get(meta.id);
          const time = solve?.penalty === 'DNF' ? 'DNF' : fmt((solve?.timeMs ?? meta.timeMs) + (solve?.penalty === '+2' ? 2000 : 0));
          const details = [fmtDate(meta.at), sessions.get(solve?.sessionId) || t('Solve details unavailable'),
            meta.partial ? t('Interrupted footage') : '', meta.pinned ? t('Keep forever') : ''].filter(Boolean).join(' · ');
          return el('div', { class: 'row', role: 'listitem' },
            el('div', { class: 'lbl' }, el('span', { text: time }), el('span', { class: 'sub', text: details })),
            el('button', { class: 'ghost-btn sm', text: t('Watch replay'), onclick: () => openReplay(solve || meta.id) }));
        }));
      } catch {
        if (!disposed && request === revision) status.textContent = t('Saved replay storage is unavailable. Keep this tab open and use Recover recordings.');
      } finally { if (!disposed && request === revision) retry.disabled = false; }
    }
    const off = onReplayChange(e => { if (e.type === 'removed' || e.type === 'pinned') load(); });
    load();
    if (recovery) inspect();
    return () => { disposed = true; revision++; scanRevision++; off(); };
  };
}
