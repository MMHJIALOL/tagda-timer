// Disposable browser data only. Start serve.py, then run this check with Playwright available.
const assert=require('node:assert/strict');const{chromium}=require(process.env.TAGDA_PLAYWRIGHT_PATH || 'playwright');
(async()=>{const b=await chromium.launch({headless:true}),p=await b.newPage();await p.goto(`${process.argv[2] || 'http://localhost:5184'}/tools/`);const checks=await p.evaluate(async()=>{
const opened=await new Promise((resolve,reject)=>{const r=indexedDB.open('tagdatimer',3);r.onupgradeneeded=()=>{const d=r.result,s=d.createObjectStore('solves',{keyPath:'id'});s.createIndex('bySession','sessionId');s.createIndex('byCreated','createdAt');s.createIndex('byCase','caseId');d.createObjectStore('sessions',{keyPath:'id'});d.createObjectStore('kv');d.createObjectStore('assets');d.createObjectStore('letterPairs',{keyPath:'pair'});d.createObjectStore('gear',{keyPath:'id'});d.createObjectStore('gearLog',{keyPath:'id'}).createIndex('byGear','gearId');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
await new Promise(res=>{const tr=opened.transaction('solves','readwrite');tr.objectStore('solves').put({id:'old',sessionId:'old-session',event:'333',mode:'wca',timeMs:12345,penalty:'none',createdAt:1});tr.oncomplete=res;});opened.close();
const{Solves,CompetitionSets,Sessions,KV,exportAll,importAll}=await import('/js/db.js');const preserved=(await Solves.get('old')).timeMs===12345;
await Sessions.put({id:'qa-session',name:'QA',createdAt:1,event:'333'});
const c={id:'qa-set',sessionId:'qa-session',event:'333',size:5,status:'active',solveIds:[],createdAt:Date.now(),currentScramble:{scramble:'R U',official:true},recordingMode:'none',replayStatus:'none'};await CompetitionSets.create(c);
const make=id=>({id,sessionId:'qa-session',event:'333',mode:'wca',scramble:'R U',timeMs:10000,penalty:'none',createdAt:Date.now()});
const concurrent=await Promise.allSettled([CompetitionSets.record(c.id,make('one'),1),CompetitionSets.record(c.id,make('two'),1)]);
const once=concurrent.filter(x=>x.status==='fulfilled').length===1&&(await CompetitionSets.get(c.id)).solveIds.length===1;
const set=await CompetitionSets.get(c.id),member=(await CompetitionSets.members(set))[0];
let rawGuard=false,metadataGuard=false,batchGuard=false;try{await Solves.put({...member,timeMs:200});}catch{rawGuard=true;}try{await CompetitionSets.put({...set,size:6});}catch{metadataGuard=true;}try{await Solves.delMany([member.id,'old']);}catch{batchGuard=true;}
const atomic=!!await Solves.get('old')&&!!await Solves.get(member.id);
const backup=await exportAll();const corrupted=structuredClone(backup);corrupted.competitionSets[0].solveIds=['missing'];let rejected=false;try{await importAll(corrupted,{merge:false});}catch{rejected=true;}
const failedRestorePreserved=rejected&&!!await Solves.get('old')&&!!await Solves.get(member.id);
await CompetitionSets.delete(c.id);await importAll(backup);
const oldBackupCannotResurrect=!(await CompetitionSets.get(c.id))&&!(await Solves.get(member.id));
await importAll({app:'tagdatimer',version:1,solves:[{id:'v1',sessionId:'old-session',timeMs:5555,penalty:'none',createdAt:2}]});
const oldBackupOrdinary=!(await Solves.get('v1')).competitionSetId;
// Replacing everything with a backup that holds a set keeps that set, its attempts and its videos.
await CompetitionSets.create({...c,id:'qa-keep',solveIds:[]});await CompetitionSets.record('qa-keep',make('kept'),1);await importAll(await exportAll(),{merge:false});
const replaceKeepsSets=!!(await CompetitionSets.get('qa-keep'))&&!!(await Solves.get('kept'))&&!(await KV.get('_competitionMediaCleanup',[])).some(e=>e.id==='qa-keep')&&!(await KV.get('_competitionDeleted',{}))['qa-keep'];
return{migration:preserved,concurrent:once,rawGuard,metadataGuard,batchGuard,atomic,failedRestorePreserved,oldBackupCannotResurrect,oldBackupOrdinary,replaceKeepsSets};});console.log(checks);assert(Object.values(checks).every(Boolean));await b.close();})().catch(e=>{console.error(e);process.exit(1)});
