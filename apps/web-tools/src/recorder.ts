import init, { TrajectoryRecorder } from "@ossm-rs/trajectory-recorder";
import wasmUrl from "@ossm-rs/trajectory-recorder/trajectory_recorder_bg.wasm?url";

await init({ module_or_path: wasmUrl });

let recorder: TrajectoryRecorder | null = null;
export function getRecorder(): TrajectoryRecorder {
  if (!recorder) {
    recorder = new TrajectoryRecorder();
  }
  return recorder;
}
