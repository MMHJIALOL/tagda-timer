# Hardware-free local demo

Run `npm run demo:smart-cube` from the project folder, then use
<http://127.0.0.1:5387/smart-cube-demo.html>.

- **Full test** rotates the actual 3D cube with simulated gyro notifications,
  applies the scramble, inserts and corrects a wrong turn, starts inspection,
  and records an 11.22-second solve. The reconstruction opens automatically.
- **Gyro** runs a short rotation-only test. Quaternion values and received-sample
  counts appear above the timer. The facelet state, move serial and timer remain
  unchanged. **Re-centre** resets only the view's orientation reference.
- **Wrong turn** makes a few correct scramble moves, inserts a mistake
  and pauses on the amber correction. Completed moves stay green. The demo
  follows the correction, finishes scrambling and runs the solve.
- **Recon** opens the ready-made example immediately. Try playback, move
  stepping, speeds, seeking, annotations and phase/range timings. The replay's
  **Replay gyroscope** switch independently enables recorded orientation.
- **Full reconstruction** expands the complete solution grouped by phase.
  Sune (OLL 27) and T-perm appear as exact algorithm matches; their markers and
  phase rows seek directly to those parts of the solve. **Moves** shows every
  timestamp and gap; **Segments** contains the four named ranges. JSON export
  includes the orientation samples alongside the original turn evidence.
- Clicking a sample time in the real timer also opens its analysis.
- **Stop** preserves an interrupted demo attempt when execution has begun.
- **Settings → Smart cube → Configure**, or the gear beside the connected
  cube, opens preview size, rear sticker visibility and device controls.

The demo uses the existing main timer, preview, persistence and historical
analysis. Its repeatable 33-quarter-turn solution contains a cross, a last F2L
pair, Sune and T-perm. The displayed scramble is the inverse solution in ordinary
notation, including half turns. Phase boundaries are authored for this example,
checked against the resulting cube states, and labelled scripted in the analysis.
OLL/PLL recognition uses the normal exact-matching engine. Sample data and gyro
are marked simulated and excluded from account upload.
The dedicated localhost port keeps its local history separate from normal
practice on other origins. No Bluetooth permission or device is used.

Guidance tracks the reported cube position, accepts either direction of a half
turn and keeps the timer idle until the scramble matches. An unfamiliar starting
position gets a local recovery route back to solved before the displayed
scramble. Correction moves are preparation and do not enter the solve recording.

The extra entry point activates only on localhost with `smartCubeDemo=1`.
Normal timer startup does not load the simulator. The demo launcher binds to
127.0.0.1 and leaves the ordinary development server unchanged.

`npm run test:smart-cube-demo` checks the GPU puzzle quaternion, unchanged logical
state during rotation, recorded/replayed gyro, correction guidance, complete
timed recording, exact algorithm matches, reconstruction and nine screen sizes.
