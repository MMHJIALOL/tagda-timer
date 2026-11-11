# Hardware-free local demo

Run `npm run demo:smart-cube` from the project folder, then use
<http://127.0.0.1:5387/smart-cube-demo.html>.

- **Watch a solve** animates the scramble, starts inspection and feeds a
  simulated 11.22-second solve through the real controller. Each run uses a
  standard random-state 3×3 scramble, including ordinary half-turn notation.
- **Test a wrong turn** makes a few correct scramble moves, inserts a mistake
  and pauses on the amber correction. Completed moves stay green. The demo
  follows the correction, finishes scrambling and runs the solve.
- **Open analysis** opens the ready-made example immediately. Try playback,
  move stepping, speeds, seeking, annotations and phase/range timings.
- Clicking a sample time in the real timer also opens its analysis.
- **Stop** preserves an interrupted demo attempt when execution has begun.
- **Settings → Smart cube → Configure**, or the gear beside the connected
  cube, opens preview size, rear sticker visibility and device controls.

The demo uses the existing main timer, preview, persistence and historical
analysis. The simulated solution reverses the scramble; phase boundaries are
detected from its actual cube states. Sample data is marked simulated and
excluded from account upload.
The dedicated localhost port keeps its local history separate from normal
practice on other origins. No Bluetooth permission or device is used.

Guidance tracks the reported cube position, accepts either direction of a half
turn and keeps the timer idle until the scramble matches. An unfamiliar starting
position gets a local recovery route back to solved before the displayed
scramble. Correction moves are preparation and do not enter the solve recording.

The extra entry point activates only on localhost with `smartCubeDemo=1`.
Normal timer startup does not load the simulator. The demo launcher binds to
127.0.0.1 and leaves the ordinary development server unchanged.
