export const RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const MAX_BYTES = 2 * 1024 * 1024;
const ID = /^[a-f0-9]{32}$/;
const encoder = new TextEncoder();

export const responseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'bluetooth=(self)',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: responseHeaders });
}

async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signature(secret, id, expiresAt) {
  const bytes = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(`${id}.${expiresAt}`));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

async function verify(secret, token, id, expiresAt) {
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const bytes = Uint8Array.from(token.match(/../g), b => parseInt(b, 16));
  return crypto.subtle.verify('HMAC', await signingKey(secret), bytes, encoder.encode(`${id}.${expiresAt}`));
}

// Enforce the actual streamed size as well as Content-Length.
async function readBody(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) throw new Error('size');
  if (!request.body) throw new Error('json');
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('size');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function validReport(report) {
  return report && report.schemaVersion === 1 && report.source === 'tagda-smart-cube-test'
    && Array.isArray(report.events) && report.events.length <= 20001
    && report.events.every(event => event && typeof event.type === 'string' && event.type.length <= 60
      && Number.isFinite(event.receivedAt))
    && Array.isArray(report.solves) && report.solves.length <= 1000
    && typeof report.model === 'string' && report.model.length <= 120
    && typeof report.notes === 'string' && report.notes.length <= 2000;
}

export async function handleApi(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!env.REPORTS || !env.UPLOAD_SECRET) return json({ error: 'Cloud storage is unavailable. Download the report and try again later.' }, 503);
  if (request.method === 'POST' || request.method === 'PUT') {
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Open the test page to upload reports.' }, 403);
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'JSON required.' }, 415);
    const limit = await env.UPLOAD_LIMIT?.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
    if (limit && !limit.success) return json({ error: 'Too many uploads. Please retry in a minute.' }, 429);
  }
  if (path === '/smart-cube/api/sessions' && request.method === 'POST') {
    const id = crypto.randomUUID().replaceAll('-', '');
    const expiresAt = (Math.floor(now / 1000) + RETENTION_SECONDS) * 1000;
    return json({ id, expiresAt, token: await signature(env.UPLOAD_SECRET, id, expiresAt) }, 201);
  }
  const match = /^\/smart-cube\/api\/reports\/([a-f0-9]{32})$/.exec(path);
  if (!match || !ID.test(match[1])) return json({ error: 'Not found.' }, 404);
  const id = match[1];
  if (request.method === 'GET') {
    const stored = await env.REPORTS.get(`report:${id}`, 'json');
    if (!stored || stored.expiresAt <= now) return json({ error: 'Report unavailable. New tests are kept for 7 days; each report shows its deletion date. A new upload can take a minute to appear.' }, 404);
    return json(stored);
  }
  if (request.method !== 'PUT') return json({ error: 'Method not allowed.' }, 405);
  const expiresAt = Number(request.headers.get('X-Report-Expires'));
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!Number.isSafeInteger(expiresAt) || !await verify(env.UPLOAD_SECRET, token, id, expiresAt)) return json({ error: 'Invalid upload permission.' }, 403);
  // Never refresh the expiry on autosave, retries, or reconnects.
  if (expiresAt - now < 60000) return json({ error: 'This test has expired. Download your report, then start a new test.' }, 410);
  let report;
  try { report = await readBody(request); }
  catch (error) { return json({ error: error.message === 'size' ? 'Report exceeds 2 MB. Download it, then start a new test.' : 'Invalid JSON report.' }, error.message === 'size' ? 413 : 400); }
  if (!validReport(report)) return json({ error: 'Invalid report format.' }, 400);
  const savedAt = Date.now();
  // Construct the envelope here so the browser cannot replace retention fields.
  await env.REPORTS.put(`report:${id}`, JSON.stringify({ id, expiresAt, savedAt, report }), {
    expiration: expiresAt / 1000,
    metadata: { model: report.model, events: report.events.length, expiresAt },
  });
  return json({ id, expiresAt, savedAt, eventCount: report.events.length });
}
