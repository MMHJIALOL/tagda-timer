const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const browser = await chromium.launch({ headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ serviceWorkers:'block', viewport:{width:1440,height:1000} });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `${process.argv[2] || 'http://127.0.0.1:5387'}/smart-cube-demo.html?ui=106`;
    const load = async () => {
      await page.goto(url);
      await page.waitForFunction(() => !document.querySelector('#run').disabled, null, {timeout:60000});
      const frame = page.frames().find(frame => frame.url().includes('smartCubeDemo=1'));
      await frame.waitForFunction(() => window.smartCubeDemo?.controller.preview.root.classList.contains('smart-3d-ready'));
      return frame;
    };
    let frame = await load();
    const scramble = await frame.evaluate(() => ({ displayed:document.querySelector('#scramble-text').textContent, expected:smartCubeDemo.scenario.scramble }));
    assert.equal(scramble.displayed, scramble.expected);
    assert.ok(scramble.displayed.split(' ').length <= 30);
    assert.match(scramble.displayed, /2/);

    const stateBeforeGyro=await frame.evaluate(()=>({state:smartCubeDemo.controller.stream.state,serial:smartCubeDemo.controller.stream.serial}));
    await page.locator('#gyro').click();
    await frame.waitForFunction(()=>{
      const p=smartCubeDemo.controller.preview;
      return p.orientationObject&&Math.abs(p.orientationObject.quaternion.x)>.05;
    });
    assert.match(await page.locator('#gyro-readout').textContent(),/samples/);
    const stateDuringGyro=await frame.evaluate(()=>({state:smartCubeDemo.controller.stream.state,serial:smartCubeDemo.controller.stream.serial}));
    assert.deepEqual(stateDuringGyro,stateBeforeGyro);
    await page.waitForFunction(()=>!document.querySelector('#gyro').disabled);
    console.log('PASS: gyro rotates the actual 3D puzzle without changing the sticker state, serial or timer');

    await page.locator('#review').click();
    await frame.getByRole('dialog',{name:'Smart cube analysis'}).waitFor();
    const follow=frame.getByRole('checkbox',{name:'Replay gyroscope',exact:true});
    await follow.waitFor();assert.equal(await follow.isChecked(),true);
    await frame.locator('.sa-phase-table tbody tr').nth(3).waitFor();
    assert.equal(await frame.locator('.sa-alg-card').count(),2);
    await frame.getByText('Full reconstruction',{exact:true}).click();
    assert.match(await frame.locator('.sa-reconstruction').textContent(),/\/\/ Cross[\s\S]*\/\/ F2L[\s\S]*\/\/ OLL[\s\S]*\/\/ PLL/);
    const replayOrientation=await frame.evaluate(async()=>{
      const timeline=document.querySelector('.sa-seek');timeline.value='4500';timeline.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      const player=document.querySelector('.smart-analysis twisty-player');
      const object=await player.experimentalCurrentThreeJSPuzzleObject();return object.quaternion.toArray();
    });
    assert.ok(replayOrientation.slice(0,3).some(v=>Math.abs(v)>.05));
    await follow.uncheck();
    const fixed=await frame.evaluate(async()=>{
      const player=document.querySelector('.smart-analysis twisty-player');return (await player.experimentalCurrentThreeJSPuzzleObject()).quaternion.toArray();
    });
    assert.ok(fixed.slice(0,3).every(v=>Math.abs(v)<1e-8));
    await follow.check();
    await page.screenshot({path:path.join(os.tmpdir(),'smart-cube-gyro-reconstruction-desktop.png')});
    await frame.getByRole('button',{name:'Close',exact:true}).click();
    console.log('PASS: saved gyro seeking and toggle, four checked phases, Sune/T-perm matches and full reconstruction');

    await frame.locator('#btn-settings').click();
    const smartGroup = frame.locator('#drawer-body .group').filter({has:frame.getByRole('heading',{name:'Smart cube',exact:true})});
    await smartGroup.getByRole('button',{name:'Configure',exact:true}).click();
    await frame.getByRole('heading',{name:'Smart cube',exact:true}).waitFor();
    const size = frame.getByRole('slider',{name:'Cube size',exact:true});
    const setSize = value => size.evaluate((element,value) => { element.value=String(value); element.dispatchEvent(new Event('input',{bubbles:true})); },value);
    const defaultWidth = await frame.locator('.smart-live-cube').evaluate(element=>element.getBoundingClientRect().width);
    await setSize(65);
    assert.ok(await frame.locator('.smart-live-cube').evaluate(element=>element.getBoundingClientRect().width) < defaultWidth * .8);
    await setSize(90);
    const hints = frame.getByRole('checkbox',{name:'Show rear stickers',exact:true});
    assert.equal(await hints.isChecked(),true);
    await hints.locator('..').click();
    assert.equal(await hints.isChecked(),false);
    assert.equal(await frame.locator('#smart-cube-wrap twisty-player').getAttribute('hint-facelets'),'none');
    await hints.locator('..').click();
    assert.equal(await frame.locator('#smart-cube-wrap twisty-player').getAttribute('hint-facelets'),'floating');
    const net = frame.getByRole('checkbox',{name:'Use sticker net',exact:true});
    await net.locator('..').click();
    assert.equal(await hints.isDisabled(),true);
    await frame.locator('#smart-cube-wrap .smart-preview.smart-net').waitFor();
    await net.locator('..').click();
    await frame.waitForFunction(async()=>((await (await import('/js/db.js')).KV.get('settings')).smartCubeSize===90));
    frame = await load();
    assert.equal(await frame.evaluate(()=>tagdatimer.settings.smartCubeSize),90);
    assert.equal(await frame.locator('#smart-cube-wrap twisty-player').getAttribute('hint-facelets'),'floating');
    console.log('PASS: Settings → Smart cube, persistent live size, rear stickers, flat net and gear shortcut');
    // A desktop-expanded stats panel stays hidden on phones. Its stored state
    // must not reserve the tablet rail's 46vh and collapse the live cube row.
    await frame.evaluate(async()=>{
      await tagdatimer.setSetting('statsCollapsed',false);
      tagdatimer.syncStatsCollapsed();
    });

    const checkLayout = async (width,height,stage) => {
      await page.setViewportSize({width,height});
      await page.waitForTimeout(300);
      const boxes = await frame.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        const zone=document.querySelector('#timer-zone');
        return { width:innerWidth, height:innerHeight, documentWidth:document.documentElement.scrollWidth,
          statsRail:rect('#sidebar-right'), statsExpanded:document.querySelector('#panel-stats').dataset.collapsed==='false',
          zone:rect('#timer-zone'), cube:rect('.smart-live-cube'), clock:rect('#timer-core'), controls:rect('.smart-live-header'),
          footer:rect('.smart-live-footer'), scrollWidth:zone.scrollWidth, clientWidth:zone.clientWidth, scrollHeight:zone.scrollHeight, clientHeight:zone.clientHeight };
      });
      assert.ok(boxes.cube.height >= 100, JSON.stringify(boxes));
      assert.ok(boxes.cube.bottom <= boxes.height+1, JSON.stringify(boxes));
      assert.ok(boxes.controls.top >= boxes.zone.top-1, JSON.stringify(boxes));
      assert.ok(boxes.clock.right <= boxes.width+1, JSON.stringify(boxes));
      assert.ok(boxes.documentWidth <= boxes.width+1, JSON.stringify(boxes));
      assert.ok(boxes.scrollWidth <= boxes.clientWidth+1, JSON.stringify(boxes));
      if(width<=1059) {
        assert.ok(boxes.cube.right <= boxes.clock.left+1, JSON.stringify(boxes));
        assert.ok(boxes.footer.top >= Math.max(boxes.cube.bottom,boxes.clock.bottom)-1, JSON.stringify(boxes));
        assert.ok(boxes.scrollHeight <= boxes.clientHeight+2, JSON.stringify(boxes));
      }
      if(width<=640) {
        assert.equal(boxes.statsExpanded,true);
        assert.ok(boxes.statsRail.height<=1,JSON.stringify(boxes));
      }
      if([1440,528,390].includes(width)) await page.screenshot({path:path.join(os.tmpdir(),`smart-cube-106-${stage}-${width}.png`)});
    };
    const sizes = [[1440,1000],[1366,768],[1024,768],[768,1024],[528,1160],[460,929],[390,844],[360,740],[320,568]];
    for(const [width,height] of sizes) await checkLayout(width,height,'before');

    await page.setViewportSize({width:528,height:1160});
    await page.locator('#run').click();
    await frame.locator('#smart-cube-wrap[data-correcting=true]').waitFor({timeout:15000});
    const mistake = await frame.evaluate(() => ({
      timer:smartCubeDemo.controller.timer.state,
      green:document.querySelectorAll('.smart-scramble-token.is-done').length,
      text:document.querySelector('#scramble-text').textContent,
      scramble:smartCubeDemo.scenario.scramble,
    }));
    assert.equal(mistake.timer,'idle');assert.ok(mistake.green>0);assert.equal(mistake.text,mistake.scramble);
    await checkLayout(528,1160,'correction');
    await frame.waitForFunction(()=>document.querySelector('#smart-cube-wrap').dataset.attempt==='inspection',null,{timeout:10000});
    const inspection = await frame.evaluate(()=>{
      const rect=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();
      return {cube:rect('.smart-live-cube'),countdown:rect('#inspect-readout'),footer:rect('.smart-live-footer')};
    });
    assert.ok(inspection.cube.right<=inspection.countdown.left+1,JSON.stringify(inspection));
    assert.ok(inspection.countdown.bottom<=inspection.footer.top+1,JSON.stringify(inspection));
    await page.waitForFunction(()=>!document.querySelector('#run').disabled,null,{timeout:30000});
    const capture = await frame.evaluate(async()=>{
      const capture=await (await import('/js/db.js')).SmartCaptures.get(smartCubeDemo.lastSolve.id);
      return {moves:capture.moves.length,expected:smartCubeDemo.scenario.moves.length,duration:capture.measuredDurationMs,completeness:capture.completeness,gyro:capture.orientation?.samples.length||0};
    });
    assert.equal(capture.moves,capture.expected);assert.equal(capture.duration,11220);assert.equal(capture.completeness,'complete');
    assert.ok(capture.gyro>=80);
    await frame.getByRole('checkbox',{name:'Replay gyroscope',exact:true}).waitFor();
    await page.screenshot({path:path.join(os.tmpdir(),'smart-cube-gyro-reconstruction-phone.png')});
    await frame.getByRole('button',{name:'Close',exact:true}).click();
    for(const [width,height] of sizes) await checkLayout(width,height,'after');
    await page.setViewportSize({width:460,height:929});
    frame = await load();
    const restoredStats = await frame.evaluate(()=>({
      expanded:document.querySelector('#panel-stats').dataset.collapsed==='false',
      railHeight:document.querySelector('#sidebar-right').getBoundingClientRect().height,
      cubeHeight:document.querySelector('.smart-live-cube').getBoundingClientRect().height,
    }));
    assert.equal(restoredStats.expanded,true);assert.ok(restoredStats.railHeight<=1);assert.ok(restoredStats.cubeHeight>=100);
    console.log('PASS: full solve, nine screen sizes and phone cold reload with saved expanded statistics');

    await frame.getByRole('button',{name:'Cube settings',exact:true}).click();
    await frame.getByRole('slider',{name:'Cube size',exact:true}).waitFor();
    await frame.evaluate(()=>smartCubeDemo.controller.disconnect());
    await frame.getByRole('searchbox',{name:'Search settings',exact:true}).waitFor();
    assert.equal(await frame.locator('#drawer-body .group').filter({has:frame.getByRole('heading',{name:'Smart cube',exact:true})}).isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log('PASS: smart-cube preferences hide on disconnect; no uncaught browser errors');
  } finally { await browser.close(); }
})().catch(error=>{ console.error(error); process.exitCode=1; });
