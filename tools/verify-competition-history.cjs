// Disposable data: mixed ordinary solves, large round pagination, and leave/resume controls.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.TAGDA_PLAYWRIGHT_PATH || 'playwright');
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto(process.argv[2] || 'http://localhost:5184');
    await page.waitForFunction(()=>window.tagdatimer?.scramble?.scramble,null,{timeout:60000});
    await page.evaluate(async()=>{
      const {importAll}=await import('/js/db.js');
      const session=tagdatimer.session,sets=[],solves=[];
      for(const [sequence,size] of [[1,5],[2,100]]) {
        const c={id:`qa-round-${sequence}`,sessionId:session.id,event:'333',size,sequence,status:'complete',solveIds:[],recordingMode:'none',createdAt:sequence*100};
        for(let i=1;i<=size;i++) {
          const s={id:`${c.id}-${i}`,sessionId:session.id,event:'333',mode:'wca',timeMs:10000+i*10,penalty:'none',scramble:'R U',createdAt:sequence*100+i,competitionSetId:c.id,competitionAttempt:i};
          c.solveIds.push(s.id);solves.push(s);
        }
        sets.push(c);
      }
      solves.push({id:'qa-ordinary',sessionId:session.id,event:'333',mode:'wca',timeMs:9999,penalty:'none',createdAt:1000});
      await importAll({app:'tagdatimer',version:2,sessions:[session],solves,competitionSets:sets});
      await tagdatimer.competitionRefresh();await tagdatimer.reloadCompetitionSolves();
    });
    assert.equal(await page.locator('.hist-cols').isVisible(),true);
    assert.equal(await page.locator('.competition-set-box').count(),1);
    assert.match(await page.locator('.competition-set-footer').innerText(),/100 attempts/);
    await page.locator('#hist-list').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await page.waitForFunction(()=>document.querySelectorAll('#hist-list .solve-chip').length===106);
    assert.equal(await page.locator('.competition-set-box').count(),2);
    assert.equal(await page.locator('[data-set-id="qa-round-2"] .solve-chip').count(),100);
    assert.equal(await page.locator('#hist-list > .solve-chip').count(),1);
    await page.locator('.hist-cols [data-sort="time"]').click();
    await page.locator('#hist-list').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await page.waitForFunction(()=>document.querySelectorAll('#hist-list .solve-chip').length===106);
    assert.equal(await page.locator('.competition-set-box').count(),2);
    await page.evaluate(async()=>{
      const {CompetitionSets}=await import('/js/db.js');
      await CompetitionSets.create({id:'qa-empty',sessionId:tagdatimer.session.id,event:'333',size:5,sequence:3,status:'active',solveIds:[],recordingMode:'none',createdAt:Date.now(),currentScramble:tagdatimer.scramble});
      await tagdatimer.competitionRefresh();
      const {resumeCompetition}=await import('/js/competition.js');await resumeCompetition('qa-empty');
    });
    assert.equal(await page.locator('#competition-strip').isVisible(),true);
    await page.evaluate(async()=> (await import('/js/competition.js')).leaveCompetition());
    assert.equal(await page.locator('#competition-strip').isVisible(),false);
    assert.equal(await page.locator('[data-set-id="qa-empty"]').count(),1);
    await page.evaluate(async()=> (await import('/js/competition.js')).resumeCompetition('qa-empty'));
    assert.equal(await page.locator('#competition-strip').isVisible(),true);
    assert(!errors.length,errors.join('\n'));
    console.log('Mixed history, Ao100 pagination, sorting, empty round and leave/resume: passed');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
