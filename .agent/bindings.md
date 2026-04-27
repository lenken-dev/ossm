# bindings/

WASM bindings that re-export Rust functionality to TypeScript. Both packages are consumed by [apps/web-tools](web-tools.md) via local `link:` deps.

```
bindings/
  web-simulator/        # full simulator: Ossm + MotionController + PatternEngine in the browser
  trajectory-recorder/  # offline trajectory grapher: planner-only, no engine loop
```

Both build with `cargo +stable` to `wasm32-unknown-unknown`, then `wasm-bindgen --target web`, then `wasm-opt -O`. Output goes to `bindings/<name>/pkg/` along with a hand-written `package.json` so `apps/web-tools` can `link:` the directory.

The `pkg/` directory is generated, not a member of `apps/web-tools`'s `pnpm-workspace.yaml`. It's included via `link:../../bindings/<name>/pkg`.

## `web-simulator`

[bindings/web-simulator/src/lib.rs](../bindings/web-simulator/src/lib.rs).

Runs the same `ossm` + `pattern-engine` stack as real firmware, against [SimMotor](drivers.md#sim-motor) instead of a hardware motor. Exposed to JS as a `Simulator` class with `wasm_bindgen` methods for:

- Issuing `PlaybackCommand` / `InputCommand` (re-using `pattern_engine::commands`).
- Subscribing to `EngineState` and `MotionState`.
- Listing patterns.

Why this matters: a contributor can iterate on a pattern entirely in the browser, with millisecond feedback, and the behavior matches what real hardware does because it's the same code path. This is the project's main quality safety net.

`embassy-time` runs in `wasm` mode with a generic queue. `critical-section` uses the `std` impl. Logging goes to `console.log` via `web-sys`.

## `trajectory-recorder`

[bindings/trajectory-recorder/src/lib.rs](../bindings/trajectory-recorder/src/lib.rs).

Lighter-weight: it doesn't run the engine loop. Instead it drives the Ruckig planner directly with synthetic inputs and emits the resulting trajectory as samples for the graphing UI in `web-tools`. Used to visualise what a given `MotionLimits` + pattern target sequence would produce.

Constants here mirror firmware (`TIMESTEP_MS = 10.0`) so the graph matches real hardware tick rate.

## Adding a new binding

If you need new functionality in the browser, prefer extending one of these crates over creating a third. Two reasons:

1. The build pipeline (cargo + wasm-bindgen + wasm-opt + tiny package.json) is already in [the justfile](../justfile).
2. Two packages already cost a chunk of bundle size and TypeScript boilerplate in the consuming app.

If a new binding is genuinely warranted, copy the [Cargo.toml](../bindings/web-simulator/Cargo.toml) layout - in particular:

- `crate-type = ["cdylib"]`
- `[workspace] members = ["."]` (independent workspace, like firmware)
- `wasm-bindgen` pinned to `=0.2.118` (must match `wasm-pack`/`wasm-bindgen` CLI version on the host)
- `embassy-time` features: `wasm`, `generic-queue-32`
- `critical-section` features: `std`

Then add `build-wasm-<name>` and `build-wasm` recipes to the [justfile](../justfile).

## Don't put TypeScript here

`bindings/<name>/pkg/` is the _generated_ TS surface. The hand-written TS that consumes it lives in [apps/web-tools/src/](../apps/web-tools/src/). Keep that boundary clean.
