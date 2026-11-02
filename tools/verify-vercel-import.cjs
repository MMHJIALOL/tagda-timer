// Isolated browser storage only: all requests to the named hosts are intercepted.
// No requests or test data reach either production site.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.TAGDA_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const old = 'https://tagdatimer.vercel.app';
const current = 'https://tagdatimer.me';
const harness = `<!doctype html><html><body><div id="toasts"></div><script type="module">
  import { buildVercelImport } from '/js/vercel-import.js';
  document.body.append(buildVercelImport());
  window.ready = true;
</script></body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.TAGDA_CHROME_PATH ? { executablePath: process.env.TAGDA_CHROME_PATH } : { channel: 'chrome' }) });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (![old, current].includes(url.origin)) return route.abort();
      if (url.pathname === '/' || url.pathname === '/seed') return route.fulfill({ contentType: 'text/html', body: harness });
      const file = url.pathname === '/import-from-vercel' ? 'vercel-mover/import-data.html' : url.pathname.slice(1);
      if (!/^(js|locales|vercel-mover)\/[\w./-]+$/.test(file)) return route.abort();
      await route.fulfill({ contentType: file.endsWith('.html') ? 'text/html' : 'text/javascript', body: await fs.readFile(path.join(root, file)) });
    });
    const page = await context.newPage();
    const seed = async (url, name, time, theme) => {
      await page.goto(url + '/seed');
      await page.waitForFunction(() => window.ready);
      await page.evaluate(async ({name,time,theme}) => {
        const db = await import('/js/db.js');
        await db.Sessions.put({id:'shared-session', name, event:'333', createdAt:1});
        await db.Solves.put({id:'shared-solve',sessionId:'shared-session',event:'333',timeMs:time,createdAt:2});
        await db.KV.set('settings',{theme});
      }, {name,time,theme});
    };
    await seed(old, 'Old session', 12000, 'old-theme');
    await page.evaluate(async () => {
      const db = await import('/js/db.js');
      await db.Solves.put({id:'old-only',sessionId:'shared-session',event:'333',timeMs:15000,createdAt:3});
    });
    await seed(current, 'Renamed session', 11000, 'current-theme');
    const runImport = async () => {
      const reloaded = page.waitForEvent('load');
      await page.getByRole('button', {name:'Import from .vercel.app'}).click();
      await reloaded;
      await page.waitForFunction(() => window.ready && sessionStorage.getItem('tdt-moved-count') !== null);
      return page.evaluate(async () => {
        const data = await (await import('/js/db.js')).exportAll();
        const count = sessionStorage.getItem('tdt-moved-count');
        sessionStorage.removeItem('tdt-moved-count');
        return {data,count};
      });
    };
    let result = await runImport();
    assert.equal(result.count, '1');
    assert.equal(result.data.solves.length, 2);
    assert.equal(result.data.solves.find(s=>s.id==='shared-solve').timeMs,11000);
    assert.equal(result.data.sessions[0].name,'Renamed session');
    assert.equal(result.data.settings.theme,'current-theme');
    console.log('PASS cross-origin import adds old solves, keeps current records and settings');
    await page.getByRole('checkbox', {name:'Include old settings'}).check();
    result = await runImport();
    assert.equal(result.count,'0');
    assert.equal(result.data.solves.length,2);
    assert.equal(result.data.settings.theme,'old-theme');
    console.log('PASS repeat import is deduplicated; settings import is optional');
    await page.goto(old + '/seed');
    await page.waitForFunction(()=>window.ready);
    const original = await page.evaluate(async () => (await import('/js/db.js')).exportAll());
    assert.equal(original.solves.length,2);
    assert.equal(original.solves.find(s=>s.id==='shared-solve').timeMs,12000);
    console.log('PASS old data is unchanged');
    await context.close();

    // A fresh context has no old storage.
    const empty = await browser.newContext({ serviceWorkers:'block' });
    await empty.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (![old,current].includes(url.origin)) return route.abort();
      if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:harness});
      const file = url.pathname === '/import-from-vercel' ? 'vercel-mover/import-data.html' : url.pathname.slice(1);
      if (!/^(js|locales|vercel-mover)\/[\w./-]+$/.test(file)) return route.abort();
      await route.fulfill({contentType:file.endsWith('.html')?'text/html':'text/javascript',body:await fs.readFile(path.join(root,file))});
    });
    const fresh = await empty.newPage();
    await fresh.goto(current);
    await fresh.getByRole('button',{name:'Import from .vercel.app'}).click();
    await fresh.getByRole('status').filter({hasText:'No saved data found'}).waitFor();
    assert.equal(await fresh.evaluate(async () => (await (await import('/js/db.js')).Solves.all()).length),0);
    console.log('PASS no old data reports a useful message without importing');
    await empty.route(old + '/import-from-vercel?*', route => route.fulfill({contentType:'text/html',body:`<script>
      opener.postMessage({type:'tagda-export-data',request:'wrong-request',data:{app:'tagdatimer',solves:[{id:'spoofed'}]}},'${current}');
    </script>`}));
    await fresh.getByRole('button',{name:'Import from .vercel.app'}).click();
    const fake = empty.pages().find(p=>p!==fresh);
    await fake.waitForLoadState();
    await fresh.evaluate(() => new Promise(resolve=>setTimeout(resolve,100)));
    assert.equal(await fresh.evaluate(async () => (await (await import('/js/db.js')).Solves.all()).length),0);
    await fake.close();
    await fresh.getByRole('status').filter({hasText:'Import cancelled'}).waitFor();
    console.log('PASS messages with an incorrect request token are ignored; closed popup can retry');
    await fresh.evaluate(()=>{window.open=()=>null;});
    await fresh.getByRole('button',{name:'Import from .vercel.app'}).click();
    await fresh.getByRole('status').filter({hasText:'Allow pop-ups'}).waitFor();
    console.log('PASS blocked popup offers a retry');
    await empty.close();
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
