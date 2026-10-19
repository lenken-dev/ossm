import init from "@ossm-rs/trajectory-recorder";
import wasmUrl from "@ossm-rs/trajectory-recorder/trajectory_recorder_bg.wasm?url";
import { follow, type FollowRequest } from "./follow";

const ready = init({ module_or_path: wasmUrl });

/** The latest request id of each channel. */
const latest = new Map<string, number>();

self.onmessage = async ({ data: { id, channel, request } }: MessageEvent<{ id: number; channel: string; request: FollowRequest }>) => {
  latest.set(channel, id);
  await ready;
  // Requests already queued arrive first, so only each channel's latest is worked out.
  await new Promise((r) => setTimeout(r));
  if (latest.get(channel) === id) self.postMessage({ id, result: follow(request) });
};
