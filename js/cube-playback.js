/* A frame is not a readiness signal: the lazy 3D renderer and the position
   model can still be loading when it fires, especially on a phone. Keep the
   clock stopped until the requested position can actually be drawn. */
export function createCubePlayback(player) {
  let revision = 0;
  const cancel = () => { ++revision; player.pause(); };
  const show = async ({ setup = '', alg = '', controls = 'none' } = {}) => {
    cancel();
    const mine = revision;
    player.setAttribute('control-panel', controls);
    player.setAttribute('experimental-setup-alg', setup);
    player.setAttribute('alg', alg);
    player.jumpToStart();
    if (!alg) return;

    const model = player.experimentalModel;
    await model.currentPattern.get();
    if (mine !== revision) return;
    const strategy = await model.visualizationStrategy.get();
    if (strategy === 'Cube3D' || strategy === 'PG3D') {
      await Promise.all([
        player.experimentalCurrentThreeJSPuzzleObject(),
        player.experimentalCurrentCanvases(),
      ]);
    }
    // Let the initial position paint before starting the animation clock.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (mine !== revision || !player.isConnected || !player.getClientRects().length) return;
    player.jumpToStart();
    player.play();
  };
  return { show, cancel };
}
