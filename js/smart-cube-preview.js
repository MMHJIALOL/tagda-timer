import { netColors, onPuzzleColorsChanged } from './puzzle-colors.js';
import { CubeView } from './cube.js';
import { fromFacelets, CORNER_NAMES, EDGE_NAMES, FACES } from './cube3.js';

const maps = new WeakMap();
let canRender3D;

function supports3D() {
  if (canRender3D !== undefined) return canRender3D;
  try {
    const context = document.createElement('canvas').getContext('webgl2');
    canRender3D = !!context;
    context?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    canRender3D = false;
  }
  return canRender3D;
}
// Cubing and the recorder order cubies differently. Identify each position by
// its incident face moves, then translate permutations without solving the cube.
export function faceletsTransformation(kpuzzle, facelets) {
  let mapping = maps.get(kpuzzle);
  if (!mapping) {
    mapping = {};
    for (const [orbit,names] of [['CORNERS',CORNER_NAMES],['EDGES',EDGE_NAMES]]) {
      const moves = FACES.map(f=>kpuzzle.moveToTransformation(f).transformationData[orbit]);
      const toRecorder = names.map((_,i)=> {
        const faces=FACES.filter((f,j)=>moves[j].permutation[i]!==i);
        return names.findIndex(n=>n.length===faces.length&&faces.every(f=>n.includes(f)));
      });
      if(toRecorder.some(i=>i<0))throw new Error('Cube renderer mapping unavailable');
      mapping[orbit]={toRecorder,toRenderer:toRecorder.map((_,i)=>toRecorder.indexOf(i))};
    }
    maps.set(kpuzzle,mapping);
  }
  const state=fromFacelets(facelets), identity=kpuzzle.identityTransformation(), data={...identity.transformationData};
  for(const [orbit,offset,orientation] of [['CORNERS',0,8],['EDGES',16,28]]) {
    const {toRecorder,toRenderer}=mapping[orbit];
    data[orbit]={permutation:toRecorder.map(i=>toRenderer[state[offset+i]]),orientationDelta:toRecorder.map(i=>state[orientation+i])};
  }
  return new identity.constructor(kpuzzle,data);
}

// Same CubeView/twisty-player as the keyboard virtual cube, with a sticker net
// only as a low-resource fallback. Recording never waits for this renderer.
export class SmartPreview {
  constructor(host) {
    this.host=host;this.state=null;this.pending=0;this.frame=0;this.disposed=false;
    this.root=document.createElement('div');this.root.className='smart-preview';
    this.stage=document.createElement('div');this.stage.className='smart-twisty-stage';
    this.netRoot=document.createElement('div');this.netRoot.className='smart-sticker-net';
    this.stickers=[];
    for(const face of 'URFDLB') {
      const side=document.createElement('div');side.className=`smart-face smart-face-${face}`;side.setAttribute('aria-label',`${face} face`);
      for(let i=0;i<9;i++){const sticker=document.createElement('span');side.append(sticker);this.stickers.push(sticker);}
      this.netRoot.append(side);
    }
    this.root.append(this.stage,this.netRoot);host.append(this.root);
    this.view=new CubeView(this.stage,null);this.view.backView='none';
    this.unsubscribe = onPuzzleColorsChanged(async () => {
      if (this.ready) {
        await this.ready;
        if (!this.disposed && this.view.player) await this.prepare();
      }
      this.set(this.state);
    });
    this.net(matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.ready ??= Promise.resolve();
  }
  async prepare() {
    try {
      if(!this.view.ready&&!await this.view.init())throw new Error('3D preview unavailable');
      if(this.disposed){this.view.dispose();return;}
      this.view.setHints(!!this.showHints);
      this.view.player.setAttribute('tempo-scale', '6');
      this.view.player.setAttribute('experimental-facelet-scale', '0.88');
      this.view.player.experimentalHintFaceletsElevation = 1.15;
      this.view.player.setAttribute('experimental-initial-hint-facelets-animation', 'none');
      const player = this.view.player;
      if (!player.hasAttribute('camera-latitude')) this.view.setOrbit({ latitude: 24, longitude: 32, distance: 6 });
      this.kpuzzle=await this.view.player.experimentalModel.kpuzzle.get();
      if (this.disposed || player !== this.view.player) return;
      for (const canvas of await player.experimentalCurrentCanvases()) {
        canvas.addEventListener('webglcontextlost', () => this.net(true), { once: true });
      }
      if(!this.disposed){this.root.classList.add('smart-3d-ready');this.paint();}
    } catch {if(!this.disposed)this.net(true);}
  }
  turn(move,before,after) {
    this.queuedTurns=(this.queuedTurns||0)+1;
    this.nextTurn={move,before,after};
  }
  set(state) {
    if(this.disposed)return;
    this.state=state;
    if(!this.pending&&!this.disposed)this.pending=requestAnimationFrame(()=>{this.pending=0;this.paint();this.frame++;});
  }
  applyState(state) {
    const model=this.view.player.experimentalModel;
    model.alg.set('');model.setupTransformation.set(faceletsTransformation(this.kpuzzle,state));
    this.view.player.pause?.();
    this.view.player.jumpToStart?.();
  }
  paint() {
    if(this.disposed)return;
    this.stickers.forEach((s,i)=>{s.style.backgroundColor=netColors[this.state?.[i]]||'#48485c';});
    const turn=this.queuedTurns===1?this.nextTurn:null;
    this.nextTurn=null;this.queuedTurns=0;
    if(!this.kpuzzle||!this.state||this.root.classList.contains('smart-net'))return;
    try {
      if(turn&&this.state===turn.after&&this.applied===turn.before&&performance.now()>(this.animatingUntil||0)&&!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        this.applyState(turn.before);this.view.addMove(turn.move);this.animatingUntil=performance.now()+110;
      } else this.applyState(this.state);
      this.applied=this.state;
    } catch {this.net(true);}
  }
  net(on) {
    const useNet = on || !supports3D();
    this.root.classList.toggle('smart-net', useNet);
    if (!useNet) {
      if (!this.view.ready && !this.starting) {
        this.starting = true;
        this.ready = this.prepare().finally(() => { this.starting = false; });
      }
      this.set(this.state);
    }
    return this.ready || Promise.resolve();
  }
  hints(on) {
    this.showHints = !!on;
    this.view.setHints(this.showHints);
  }
  reset() {this.view.setOrbit({ latitude:24, longitude:32, distance:6 });}
  dispose() {this.disposed=true;cancelAnimationFrame(this.pending);this.unsubscribe();this.view.dispose();this.root.remove();}
}
