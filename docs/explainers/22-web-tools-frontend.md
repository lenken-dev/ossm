# 22 — The web tools frontend (`apps/web-tools`)

> Prerequisites: [20-wasm-simulator.md](20-wasm-simulator.md),
> [21-trajectory-recorder.md](21-trajectory-recorder.md)

A React + TypeScript single-page app, built with Vite, that hosts both WASM
modules. If you have used QML with a C++ backend, the mental model transfers
directly: declarative UI on top, compiled logic underneath, a narrow typed
boundary between them.

## Pages

| Route | What it does | Backed by |
| --- | --- | --- |
| `/simulator` | 3D model of the ALT machine moving in real time, with a chart and sliders | both WASM modules |
| `/graph` | Position / velocity / acceleration charts only | trajectory-recorder |
| `/diagram` | Static architecture diagram | — |
| `/firmware`, `/flasher` | Flash a release or PR build to a board over WebSerial | `esptool-js`, GitHub API |

## Loading a WASM module

The generated `pkg/` directory is consumed as an ordinary npm package
(`"@ossm-rs/web-simulator": "link:../../bindings/web-simulator/pkg"`). Its
default export is an `init` function that must be awaited before anything else
in the module is touched — it fetches and instantiates the `.wasm` binary.

```tsx
import init, { Simulator } from "@ossm-rs/web-simulator";
import wasmUrl from "@ossm-rs/web-simulator/web_simulator_bg.wasm?url";

let wasmReady: Promise<void> | null = null;
function ensureWasmInit() {
  if (!wasmReady) {
    wasmReady = init({ module_or_path: wasmUrl }).then(() => {});
  }
  return wasmReady;
}
```

The `?url` suffix is a Vite import: it yields the hashed URL of the asset
rather than its contents. The memoised promise makes initialisation idempotent
under React 18+ StrictMode, which mounts effects twice in development.

## One simulator for the whole app

`SimulatorProvider` constructs exactly one `Simulator` and puts it in React
context:

```tsx
export const SimulatorContext = createContext<Simulator | null>(null);

export function SimulatorProvider({ children, fallback }) {
  const [simulator, setSimulator] = useState<Simulator | null>(null);

  useEffect(() => {
    let cancelled = false;
    ensureWasmInit().then(() => {
      if (cancelled) return;
      setSimulator(new Simulator(10.0));       // 10 ms tick
    });
    return () => { cancelled = true; };
  }, []);

  if (!simulator) return <>{fallback}</>;
  return <SimulatorContext.Provider value={simulator}>{children}</SimulatorContext.Provider>;
}
```

The provider sits above the router in `main.tsx`, so the firmware "boots"
once for the session and keeps running across page navigations — leaving the
Simulator page does not stop the motion loop.

`new Simulator(10.0)` is the `#[wasm_bindgen(constructor)]` from
[20-wasm-simulator.md](20-wasm-simulator.md). The two `spawn_local` futures it
creates outlive the call and are driven by the browser's microtask queue from
then on.

There is a deliberate asymmetry here: the `Simulator` is a singleton because
the underlying `StaticCell`s can be `init`ed only once. Constructing a second
one would panic. The recorder has the same constraint and the same singleton
treatment (`getRecorder()` in `TrajectoryPanel.tsx`).

## Reading state: two different mechanisms

The WASM boundary is pull-only — Rust cannot call into React. So both consumers
poll, but at the cadence each needs.

**The 3D model** polls inside the three.js render loop, so position is sampled
once per rendered frame and never causes a React re-render:

```tsx
useFrame(() => {
  if (railRef.current) {
    const pos = overridePosition != null ? overridePosition : simulator.get_position();
    railRef.current.position.z = -(1 - pos) * RAIL_TRAVEL;
  }
});
```

`get_position()` returns the fraction 0.0–1.0 published by `MotionObserver`;
`RAIL_TRAVEL` maps it onto the GLTF model's geometry. (`overridePosition` is
how scrubbing the chart drives the model instead.)

**The playback state** does need to re-render React (the play button changes),
so it goes through `useSyncExternalStore` with a `requestAnimationFrame` loop
that only notifies on an actual change:

```tsx
const subscribe = useCallback((onStoreChange: () => void) => {
  let raf: number;
  const poll = () => {
    const raw = simulator.get_engine_state();
    const next = STATE_LABELS[raw] ?? "stopped";
    if (next !== stateRef.current) {
      stateRef.current = next;
      onStoreChange();            // only then does React re-render
    }
    raf = requestAnimationFrame(poll);
  };
  raf = requestAnimationFrame(poll);
  return () => cancelAnimationFrame(raf);
}, [simulator]);

return useSyncExternalStore(subscribe, () => stateRef.current);
```

The `u8` it reads is `EngineState::as_u8()` from
[13-pattern-engine.md](13-pattern-engine.md) — the high byte of the
`AtomicU16`. The TS side mirrors the tags:

```ts
export const EngineState = { Stopped: 0, Homing: 1, Playing: 2, Paused: 3 } as const;
```

> This mapping is duplicated by hand on both sides. If you add an engine state
> in Rust, update `useEngineState.ts` too — nothing enforces it.

## Writing state

Straight through, no batching:

```tsx
useEffect(() => {
  simulator.set_depth(inputs.depth);
  simulator.set_stroke(inputs.stroke);
  simulator.set_velocity(inputs.velocity);
  simulator.set_sensation(inputs.sensation);
  // ...
}, [simulator, inputs.depth, inputs.stroke, inputs.velocity, inputs.sensation]);
```

Recall from [13-pattern-engine.md](13-pattern-engine.md) that these are
`Watch` writes on the Rust side and are throttled to ~4 Hz *inside* the
pattern's `send()` loop. So dragging a slider at 60 Hz is safe by
construction; the frontend does not need to debounce.

Slider values are persisted to `localStorage` via `usePersistedState`, keyed
`ossm:depth`, `ossm:stroke`, and so on, so a reload restores the session.

## The chart path

The chart does not come from the simulator. `useTrajectoryData` calls the
recorder and memoises the result on the inputs:

```ts
function generateTrajectory(pattern, depth, stroke, velocity, sensation, durationSecs) {
  const rec = getRecorder();
  const dt = rec.timestep_ms() / 1000;
  const totalSteps = Math.ceil(durationSecs / dt);
  const result = rec.record(pattern, depth, stroke, velocity, sensation, totalSteps);
  // ... build time axis, Array.from each Float32Array
}

const data = useMemo(
  () => generateTrajectory(pattern, depth, stroke, velocity, sensation, duration),
  [pattern, depth, stroke, velocity, sensation, duration],
);
```

Every slider change recomputes the whole trajectory synchronously. It is fast
enough because the recorder runs in simulated time — see
[21-trajectory-recorder.md](21-trajectory-recorder.md).

Absolute units come from the recorder too (`min_position_mm()`,
`max_position_mm()`), so the "mm / mm·s⁻¹" toggle uses the firmware's own
limits rather than numbers typed into the frontend.

## The dev loop

```sh
just web-tools     # = build-wasm, then `pnpm dev --host` in apps/web-tools
```

`vite.config.ts` contains a custom plugin, `wasmHotReload`, which watches the
Rust sources that feed the bindings:

```ts
const rustDirs = [
  "bindings/web-simulator/src",
  "bindings/trajectory-recorder/src",
  "ossm/src",
  "drivers/sim-motor/src",
  "crates/pattern-engine/src",
].map((d) => path.resolve(workspaceRoot, d));
```

On any `.rs` change it debounces 300 ms, runs `just build-wasm`, and restarts
the dev server. So editing a pattern in `crates/pattern-engine/src/patterns/`
reloads the browser with the new behaviour — the same source that will be
flashed to the board.

Two Vite settings matter for WASM and are easy to get wrong:

```ts
build: { target: "esnext" },                                    // top-level await
optimizeDeps: { exclude: ["@ossm-rs/web-simulator", "@ossm-rs/trajectory-recorder"] },
plugins: [react(), wasm(), topLevelAwait(), wasmHotReload(), cloudflare()],
```

`optimizeDeps.exclude` keeps Vite's dependency pre-bundler away from the
linked packages, which would otherwise cache a stale build.

## The flasher page

Unrelated to the simulator, but it completes the picture: `/firmware` uses
`esptool-js` over WebSerial to flash a board directly from the browser,
pulling either a tagged release artifact or a PR build from the GitHub API
(`src/api/`, deployed as a Cloudflare Worker via `@cloudflare/vite-plugin`).
That is the "web flasher" the README lists as planned.
