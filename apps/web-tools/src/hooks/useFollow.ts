import { useEffect, useId, useState } from "react";
import type { FollowRequest, FollowResult } from "../follow";
import { getRecorder } from "../TrajectoryPanel";

/** The firmware's machine range, in mm. */
export const FIRMWARE_RANGE_MM = getRecorder().max_position_mm() - getRecorder().min_position_mm();

/** localStorage key of the machine range the calculators use, in mm. */
export const RANGE_KEY = "ossm:machineRange";

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, (result: unknown) => void>();

/**
 * The answer to `request`, worked out in a worker off the main thread; the
 * last answer while the next is worked out, undefined without a request.
 * Superseded requests are skipped.
 */
export function useFollow<R extends FollowRequest>(request: R | null): FollowResult<R> | undefined {
  const channel = useId();
  const [result, setResult] = useState<FollowResult<R>>();
  useEffect(() => {
    if (!request) return;
    if (!worker) {
      worker = new Worker(new URL("../follow.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data: { id, result } }: MessageEvent<{ id: number; result: unknown }>) => waiting.get(id)?.(result);
    }
    const id = nextId++;
    waiting.set(id, (r) => {
      waiting.delete(id);
      setResult(r as FollowResult<R>);
    });
    worker.postMessage({ id, channel, request });
    // A skipped request is never answered.
    return () => void waiting.delete(id);
  }, [request, channel]);
  return request ? result : undefined;
}
