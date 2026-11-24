import { connectGanCube as connectUpstream, cubeTimestampLinearFit } from 'gan-web-bluetooth';
import { patchGanCarry4Connection } from './gan-carry4.js';

export { cubeTimestampLinearFit };
export async function connectGanCube(provider, options) {
  // Invoke requestDevice immediately to preserve the Connect button activation.
  const connection = await connectUpstream(provider);
  try { return patchGanCarry4Connection(connection, options); }
  catch (error) { try { await connection.disconnect(); } catch {} throw error; }
}
