// Only an explicit inspection choice advances this revision. Saving a theme
// from an older tab must not turn its stale inspection value into a new choice.
const PENDING_KEY = 'tagda:inspectionPending';
const revision = s => Number.isSafeInteger(s?.inspectionUpdatedAt) && s.inspectionUpdatedAt > 0
  ? s.inspectionUpdatedAt : 0;

export function mergeInspection(local, incoming) {
  const merged = { ...local, ...incoming };
  if (revision(local) && revision(local) >= revision(incoming)) {
    merged.inspection = local.inspection;
    merged.inspectionUpdatedAt = local.inspectionUpdatedAt;
  }
  return merged;
}

export function pendingInspection() {
  try {
    const pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    return typeof pending?.inspection === 'boolean' && revision(pending) ? pending : null;
  } catch { return null; }
}

export function chooseInspection(settings, value) {
  settings.inspection = !!value;
  settings.inspectionUpdatedAt = Math.max(Date.now(), revision(settings) + 1,
    revision(pendingInspection()) + 1);
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ inspection: settings.inspection,
      inspectionUpdatedAt: settings.inspectionUpdatedAt }));
  } catch { /* The immediate IndexedDB write still runs if localStorage is unavailable. */ }
}

export function inspectionCommitted(settings) {
  const pending = pendingInspection();
  if (pending && revision(settings) >= revision(pending)) {
    try { localStorage.removeItem(PENDING_KEY); } catch {}
  }
}
