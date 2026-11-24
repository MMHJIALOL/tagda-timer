// Simulate the radio/GATT boundary only. The page loads its shipped GAN bundle,
// including its real discovery, encryption, decoder and compatibility adapter.
import { GanGen4CubeEncrypter } from '../../../node_modules/gan-web-bluetooth/src/gan-cube-encrypter.ts';
import { GAN_ENCRYPTION_KEYS, GAN_GEN4_SERVICE, GAN_GEN4_COMMAND_CHARACTERISTIC, GAN_GEN4_STATE_CHARACTERISTIC } from '../../../node_modules/gan-web-bluetooth/src/gan-cube-definitions.ts';
import { fromFacelets } from '../../../js/cube3.js';
import { applyTurn, SOLVED } from '../../../js/gan-facelets.js';

Object.defineProperty(navigator, 'bluetooth', { configurable:true, value:{
  async requestDevice(options) {
    if (!options.optionalServices.includes(GAN_GEN4_SERVICE)) throw new Error('Gen4 service was not requested');
    window.__carry4Activation = navigator.userActivation.isActive;
    window.__carry4Commands = []; window.__carry4Writes = 0; window.__carry4Disconnects = 0;
    let physical = window.__carry4Initial, serial = 251, cubeClock = 1000;
    const salt = new Uint8Array([6,5,4,3,2,1]), key = GAN_ENCRYPTION_KEYS[0];
    const cipher = new GanGen4CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
    const handlers = new Set(), device = new EventTarget();
    device.name = 'GANic4_TEST'; device.id = 'test-gan-carry4';
    device.watchAdvertisements = async () => {
      queueMicrotask(() => {
        const event = new Event('advertisementreceived');
        event.manufacturerData = new Map([[1, new DataView(salt.buffer)]]);
        device.dispatchEvent(event);
      });
    };
    const state = {
      uuid:GAN_GEN4_STATE_CHARACTERISTIC,
      addEventListener(type, handler) { if (type === 'characteristicvaluechanged') handlers.add(handler); },
      removeEventListener(type, handler) { if (type === 'characteristicvaluechanged') handlers.delete(handler); },
      async startNotifications() { return this; }, async stopNotifications() { return this; },
    };
    const emit = async bytes => {
      state.value = new DataView(cipher.encrypt(bytes).buffer);
      for (const handler of [...handlers]) await handler({ target:state });
    };
    const packet = move => {
      const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
      const bits = (start,count,value) => {
        for (let i=0;i<count;i++) { const p=start+i; bytes[p>>3] |= ((value>>(count-1-i))&1)<<(7-(p&7)); }
      };
      if (move) {
        bytes.set([1,7]); view.setUint32(2,cubeClock,true); view.setUint16(6,serial,true);
        bits(64,2,move.endsWith("'")?1:0); bits(66,6,[2,32,8,1,16,4]['URFDLB'.indexOf(move[0])]);
      } else {
        // Real i Carry 4 reports always put zero in the state counter.
        bytes.set([0xED,14,0,0]); const s=fromFacelets(physical);
        for(let i=0;i<7;i++){bits(32+i*3,3,s[i]);bits(53+i*2,2,s[8+i]);}
        for(let i=0;i<11;i++){bits(69+i*4,4,s[16+i]);bits(113+i,1,s[28+i]);}
      }
      return bytes;
    };
    const padded = values => { const bytes=new Uint8Array(20);bytes.set(values);return bytes; };
    const command = {
      uuid:GAN_GEN4_COMMAND_CHARACTERISTIC,
      async writeValue(encrypted) {
        const bytes=cipher.decrypt(new Uint8Array(encrypted));
        if(bytes[0]===0xDD && bytes[3]===0xED){window.__carry4Commands.push('REQUEST_FACELETS');await emit(packet());}
        else if(bytes[0]===0xDD && bytes[3]===0xEF){window.__carry4Commands.push('REQUEST_BATTERY');await emit(padded([0xEF,2,0,88]));}
        else if(bytes[0]===0xDF){
          window.__carry4Commands.push('REQUEST_HARDWARE');
          for(const values of [[0xFE,2,0,0x10],[0xFD,2,0,0x10],[0xFC,7,0,...new TextEncoder().encode('GANic4')],[0xFA,5,0,0xE9,7,11,7]])await emit(padded(values));
        } else if(bytes[0]===0xD2){window.__carry4Commands.push('REQUEST_RESET');physical=SOLVED;}
        else if(bytes[0]===0xD1){
          window.__carry4Writes++;
          if(window.__carry4HistoryReplies){
            // Real radio replies arrive after the current notification handler.
            // A full page of older turns leaves the stock zero-counter decoder
            // blocked, then its next live turn trips the 16-move disconnect.
            const history=padded([0xD1,13,bytes[2],...Array(12).fill(0xAB)]);
            setTimeout(()=>emit(history),0);
          }
        }
        else throw new Error('Unexpected GAN command: '+bytes[0]);
      },
    };
    const service = {
      uuid:GAN_GEN4_SERVICE,
      async getCharacteristic(uuid) { return uuid===command.uuid?command:uuid===state.uuid?state:Promise.reject(new Error('Unknown characteristic')); },
    };
    device.gatt = {
      connected:false,
      async connect(){this.connected=true;return this;},
      async getPrimaryServices(){return [service];},
      disconnect(){window.__carry4Disconnects++;this.connected=false;device.dispatchEvent(new Event('gattserverdisconnected'));},
    };
    window.__carry4Turn = async move => {
      serial++; cubeClock+=100; physical=applyTurn(physical,move);
      await emit(packet(move)); await emit(packet());
    };
    return device;
  },
} });
