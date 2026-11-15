/* Visual feedback only: edits are saved before this runs. Starting a solve or
   refreshing the display cancels the motion and flushes the pending redraw. */
export function createSolveMotion({ element, settings, canPlay }) {
  let current = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function cancel() {
    const run = current;
    current = null;
    if (!run) return;
    run.animation?.cancel();
    const refresh = run.refresh;
    run.refresh = null;
    refresh?.();
  }

  async function play(action, refresh) {
    cancel();
    const node = element();
    const config = settings();
    if (!node?.animate || !canPlay() || config.motion !== 'full' ||
        config.reduceEffects || reduced.matches || document.visibilityState !== 'visible') {
      refresh();
      return;
    }
    const speed = Number(config.solveAnimationSpeed);
    const duration = 560 / (Number.isFinite(speed) ? Math.max(1, Math.min(3, speed)) : 1.75);
    const deleting = action === 'delete';
    const distance = Math.min(145, innerWidth * .17) * (action === 'DNF' ? -1 : 1);
    const run = { refresh, animation: null };
    current = run;
    try {
      run.animation = node.animate([
        { transform: 'none', opacity: 1 },
        { transform: deleting ? 'translateY(90px) scale(.9)' : `translateX(${distance}px) rotate(${Math.sign(distance) * 1.2}deg)`, opacity: deleting ? 0 : .25 }
      ], { duration: duration * .44, easing: 'cubic-bezier(.55,0,.85,.45)', fill: 'forwards' });
      await run.animation.finished;
      if (current !== run) return;
      const redraw = run.refresh;
      run.refresh = null;
      redraw();
      const outgoing = run.animation;
      run.animation = node.animate([
        { transform: deleting ? 'translateY(-20px) scale(.98)' : `translateX(${distance * .7}px)`, opacity: deleting ? 0 : .25 },
        { transform: deleting ? 'none' : `translateX(${-Math.sign(distance) * 5}px)`, opacity: 1, offset: .76 },
        { transform: 'none', opacity: 1 }
      ], { duration: duration * .56, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' });
      outgoing.cancel();
      await run.animation.finished;
    } catch (error) {
      // Web Animations rejects finished when a new attempt cancels the effect.
      if (error.name !== 'AbortError') console.warn('[solve motion]', error);
    } finally {
      if (current === run) cancel();
    }
  }

  reduced.addEventListener('change', () => { if (reduced.matches) cancel(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  return { play, cancel };
}
