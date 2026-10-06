// Disposable browser data: round boundaries, distraction-free timing, and the shared replay UI.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, firefox } = require(process.env.TAGDA_PLAYWRIGHT_PATH || 'playwright');
const url = process.argv[2] || 'http://localhost:5184';
const out = process.env.TAGDA_QA_OUTPUT || path.resolve('competition-qa');
async function start(page, mode = 'none') {
  await page.evaluate(() => tagdatimer.openCompetition());
  await page.locator('#competition-recording').selectOption(mode);
  await page.getByRole('button', { name:'Start Ao5', exact:true }).click();
  await page.waitForFunction(() => !document.querySelector('.competition-dialog'));
}
async function solve(page, n) {
  for (let i=0;i<n;i++) await page.evaluate(i => tagdatimer.recordSolve({ timeMs:11000+i*1000 }),i);
}
async function test(engine,name) {
  const browser=await engine.launch({ headless:true,
    ...(name==='Chrome' ? { args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] }
      : { firefoxUserPrefs:{ 'media.navigator.streams.fake':true, 'media.navigator.permission.disabled':true } }) });
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const verifyDownload = async (download, layout, expected) => {
    assert.match(download.suggestedFilename(), /Ao5-set-3/);
    const base64=(await fs.readFile(await download.path())).toString('base64');
    const frame=await page.evaluate(async base64=>{
      const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
      const v=document.createElement('video');v.muted=true;
      try {
        await new Promise((res,rej)=>{v.onloadeddata=res;v.onerror=()=>rej(new Error('Export is not playable'));v.src=url;});
        await new Promise(res=>{v.onseeked=res;v.currentTime=Math.min(0.3,v.duration/2);});
        const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);
        const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        if(!pixels.some((value,i)=>i%4!==3&&value>20))throw new Error('Export frame is blank');
        return {w:c.width,h:c.height,png:c.toDataURL().split(',')[1]};
      } finally {v.removeAttribute('src');v.load();URL.revokeObjectURL(url);}
    },base64);
    assert.deepEqual([frame.w,frame.h],expected);
    await fs.writeFile(path.join(out,`${name}-competition-export-${layout}.png`),Buffer.from(frame.png,'base64'));
  };
  try {
    await page.goto(url);await page.waitForFunction(()=>window.tagdatimer?.scramble?.scramble,null,{timeout:60000});
    await start(page);
    assert.equal(await page.locator('.competition-set-box').count(),1);
    assert.match(await page.locator('.competition-set-heading').innerText(),/Ao5.*Set 1/s);
    assert(!await page.locator('#competition-strip').innerText().then(s=>s.includes('cannot be deleted')));
    await page.keyboard.press('Space');
    await page.waitForFunction(()=>document.body.classList.contains('inspecting'));
    assert.equal(await page.locator('#competition-strip').evaluate(e=>getComputedStyle(e).visibility),'hidden');
    await page.screenshot({path:path.join(out,`${name}-competition-inspection.png`)});
    await page.keyboard.press('Escape');
    await solve(page,5);await page.waitForSelector('.competition-dialog');
    await page.evaluate(async()=> (await import('/js/competition.js')).closeCompetition());
    await start(page);await solve(page,5);await page.waitForSelector('.competition-dialog');
    await page.evaluate(async()=> (await import('/js/competition.js')).closeCompetition());
    assert.equal(await page.locator('.competition-set-box').count(),2);
    assert.deepEqual(await page.locator('.competition-set-title').allTextContents(),['Ao5 · Set 2','Ao5 · Set 1']);
    for(const group of await page.locator('.competition-set-box').all()) {
      assert.equal(await group.locator('.solve-chip').count(),5);
      assert.deepEqual(await group.locator('.idx').allTextContents(),['1','2','3','4','5']);
      assert.equal(await group.locator('.avg').count(),0);
      assert.equal(await group.locator('.competition-set-result').innerText(),'13.00');
    }
    await page.locator('#panel-times').screenshot({path:path.join(out,`${name}-competition-groups.png`)});
    await page.locator('.competition-set-heading').first().click();
    await page.locator('.competition-attempts select').first().selectOption('+2');
    await page.waitForFunction(()=>document.querySelector('.competition-set-result')?.textContent==='13.33');
    await page.getByRole('button',{name:'Share score sheet',exact:true}).click();await page.waitForSelector('.sh-canvas');
    await page.locator('.sh-canvas').screenshot({path:path.join(out,`${name}-competition-score.png`)});
    await page.evaluate(async()=> (await import('/js/sharedlg.js')).closeShare());
    await page.reload();await page.waitForFunction(()=>window.tagdatimer?.scramble?.scramble);
    assert.equal(await page.locator('.competition-set-box').count(),2);
    await page.setViewportSize({width:375,height:812});
    await page.locator('.ph-tab[data-tab="times"]').click();
    await page.locator('#panel-times').screenshot({path:path.join(out,`${name}-competition-groups-mobile.png`)});
    assert(await page.locator('.competition-set-box').evaluateAll(nodes=>nodes.every(e=>e.scrollWidth<=e.clientWidth)));
    assert(await page.locator('.competition-set-box').evaluateAll(nodes=>nodes.every(e=>e.scrollHeight<=e.clientHeight)));
    await page.setViewportSize({width:1440,height:1000});
    await start(page,'whole-set');await page.waitForTimeout(2200);await solve(page,5);
    await page.waitForSelector('.competition-dialog');
    await page.getByRole('button',{name:'Watch & save video',exact:true}).click();await page.waitForSelector('.replay-dlg');
    assert.equal(await page.locator('.rp-marks .rp-solve').count(),5);
    assert.equal(await page.locator('.rp-more').count(),0);
    await page.getByRole('button',{name:'Save video',exact:true}).click();
    for(const label of ['Original','Landscape','Reel'])assert(await page.locator('.rp-menu').innerText().then(s=>s.includes(label)));
    await page.locator('.replay-dlg').screenshot({path:path.join(out,`${name}-competition-video-options.png`)});
    const originalDownload=page.waitForEvent('download',{timeout:90000});
    await page.getByRole('menuitem',{name:/Original/}).click();
    await page.waitForFunction(()=>document.querySelector('.rp-export')?.dataset.done==='clean',null,{timeout:90000});
    const sourceSize=await page.locator('.rp-video').evaluate(v=>[v.videoWidth,v.videoHeight]);
    await verifyDownload(await originalDownload,'original',sourceSize);
    await page.getByRole('button',{name:'Save video',exact:true}).click();
    await page.getByRole('menuitem',{name:/Landscape/}).click();
    const wideDownload=page.waitForEvent('download',{timeout:90000});
    await page.getByRole('button',{name:'Whole picture',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.rp-export')?.dataset.done==='wide',null,{timeout:90000});
    await verifyDownload(await wideDownload,'landscape',[1920,1080]);
    await page.getByRole('button',{name:'Save video',exact:true}).click();
    await page.getByRole('menuitem',{name:/Reel/}).click();
    const reelDownload=page.waitForEvent('download',{timeout:90000});
    // Crop confirmation is the primary action inside the crop panel.
    await page.getByRole('button',{name:'Make the reel',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.rp-export')?.dataset.done==='reel',null,{timeout:90000});
    await verifyDownload(await reelDownload,'reel',[1080,1920]);
    assert(!errors.length,errors.join('\n'));
    await page.keyboard.press('Escape');
    const selftest=await context.newPage();await selftest.goto(`${url}/test.html`);
    await selftest.waitForFunction(()=>!document.querySelector('#summary').textContent.includes('running'),null,{timeout:90000});
    const summary=await selftest.locator('#summary').innerText();assert.match(summary,/All \d+ checks passed/);
    console.log(name,JSON.stringify({groups:2,inspection:'hidden',exports:['clean','wide','reel'],summary,errors}));
  } finally { await browser.close(); }
}
(async()=>{await fs.mkdir(out,{recursive:true});for(const [engine,name] of [[chromium,'Chrome'],[firefox,'Firefox']])await test(engine,name);})().catch(e=>{console.error(e);process.exitCode=1;});
