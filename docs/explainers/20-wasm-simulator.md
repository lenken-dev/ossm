# 20 — The WASM simulator (`bindings/web-simulator`)

> Prerequisites: [10-core-ossm.md](10-core-ossm.md),
> [13-pattern-engine.md](13-pattern-engine.md),
> [rust/08-wasm-bindgen.md](rust/08-wasm-bindgen.md)

## What it actually is

It is not a model of the firmware. It **is** the firmware — the same `ossm`
crate, the same `pattern-engine` crate, the same motion state machine and the
same Ruckig planner — compiled to `wasm32-unknown-unknown`, with the bottom
two layers of the stack swapped for `sim-board` + `sim-motor` and the async
executor swapped for the browser event loop.

```
    HARDWARE (ossm-alt)                   BROWSER (web-simulator)
 ┌───────────────────────────┐        ┌───────────────────────────┐
 │ BLE / ESP-NOW remote      │        │ React UI                  │
 ├───────────────────────────┤        ├───────────────────────────┤
 │ pattern-engine            │  ==    │ pattern-engine            │  identical
 ├───────────────────────────┤  ==    ├───────────────────────────┤  identical
 │ ossm (controller, Ruckig) │  ==    │ ossm (controller, Ruckig) │  identical
 ├───────────────────────────┤        ├───────────────────────────┤
 │ Rs485Board<Motor57AIM>    │  ≠     │ SimBoard<SimMotor>        │  swapped
 ├───────────────────────────┤        ├───────────────────────────┤
 │ Modbus RTU / RS-485 UART  │  ≠     │ (nothing)                 │  gone
 ├───────────────────────────┤        ├───────────────────────────┤
 │ esp-rtos interrupt exec.  │  ≠     │ wasm_bindgen_futures      │  swapped
 └───────────────────────────┘        └───────────────────────────┘
```

The whole binding is 136 lines. That is the payoff for the trait boundaries in
[12-boards-and-motors.md](12-boards-and-motors.md).

## The crate manifest

```toml
[lib]
crate-type = ["cdylib"]

[dependencies]
ossm = { path = "../../ossm", features = ["sim"] }
sim-motor = { path = "../../drivers/sim-motor" }
sim-board = { path = "../../boards/sim-board" }
pattern-engine = { path = "../../crates/pattern-engine" }

wasm-bindgen = "=0.2.118"
wasm-bindgen-futures = "0.4"
embassy-time = { version = "0.5.1", features = ["wasm", "generic-queue-32"] }
critical-section = { version = "1.2", features = ["std"] }
static_cell = "2.1.1"
web-sys = { version = "0.3", features = ["console"] }
```

Four lines here carry most of the platform-swap:

- **`crate-type = ["cdylib"]`** — build a C-ABI dynamic library rather than a
  Rust library. For the wasm target that means a `.wasm` module with exported
  functions.
- **`embassy-time` with `features = ["wasm"]`** — Embassy's time driver
  normally comes from a hardware timer peripheral. The `wasm` feature provides
  a driver backed by `setTimeout`, so `Ticker::every` and `Timer::after` work
  unchanged in a browser tab.
- **`critical-section` with `features = ["std"]`** — a critical section on an
  MCU disables interrupts. WASM is single-threaded, so this implementation is
  essentially a no-op, but the *type-level* requirement (`CriticalSectionRawMutex`
  in every Embassy channel) is satisfied and the core crate needs no `cfg`.
- **`wasm-bindgen = "=0.2.118"`** — pinned with `=` because the generated glue
  must exactly match the `wasm-bindgen` CLI version used in the build recipe.

Note also that this directory declares its own `[workspace]`, so it is not
part of the root workspace, and carries its own `rust-toolchain.toml`
(`stable`, target `wasm32-unknown-unknown`) and `.cargo/config.toml`
(`target = "wasm32-unknown-unknown"`). A plain `cargo build` in that directory
does the right thing. See [rust/06-cargo-and-builds.md](rust/06-cargo-and-builds.md).

## The exported object

```rust
#[wasm_bindgen]
pub struct Simulator {
    motion_observer: MotionObserver,
    pattern_observer: PatternObserver,
    patterns: PatternSender,
}
```

`#[wasm_bindgen]` on a struct makes it a JavaScript class; on an `impl` block
it exports the methods. The struct holds precisely the three capability
handles the UI is allowed to have: it can command the *engine* and read
motion, but it holds no `MotionSender`, so JavaScript cannot bypass the
pattern engine and drive the motor directly.

Only types with a defined JS mapping may cross the boundary — here `f64`,
`u8`, `usize`, `String`. There is no way to hand `MotionState` out as a struct
without more annotation, which is why the getters are scalar:

```rust
pub fn get_engine_state(&self) -> u8 { self.pattern_observer.state().as_u8() }
pub fn get_position(&self) -> f32   { self.motion_observer.state().position }

pub fn set_depth(&self, depth: f64)     { self.patterns.set_depth(depth); }
pub fn set_stroke(&self, stroke: f64)   { self.patterns.set_stroke(stroke); }
pub fn set_velocity(&self, v: f64)      { self.patterns.set_speed(v); }
pub fn set_sensation(&self, s: f64)     { self.patterns.set_sensation(s); }

pub fn play(&self, index: usize)        { self.patterns.play(index); }
pub fn pause(&self)                     { self.patterns.pause(); }
pub fn resume(&self)                    { self.patterns.resume(); }
pub fn stop(&self)                      { self.patterns.stop(); }
```

Every one of these takes `&self`, not `&mut self`. None of them can block or
fail. `set_depth` writes a `Watch`; `play` does a `try_send` on a channel with
capacity 4. So a JavaScript `onChange` handler firing at 60 Hz costs a couple
of atomic stores and cannot stall the render loop.

The pattern list is exposed by index, so the UI never hard-codes names:

```rust
pub fn pattern_count(&self) -> usize { commands::pattern_list().len() }
pub fn pattern_name(&self, index: usize) -> String {
    commands::pattern_list().get(index).map(|p| String::from(p.name)).unwrap_or_default()
}
```

## The constructor: a firmware boot sequence

This is the interesting part. Compare it side by side with the ESP32-S3 boot
in [30-ossm-alt.md](30-ossm-alt.md) — it is the same sequence.

```rust
#[wasm_bindgen(constructor)]
pub fn new(update_interval_ms: f64) -> Self {
    // 1. Logging: same logger, different sink.
    ossm::logging::init(log::LevelFilter::Info, |line| {
        web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(line));
    });
    ossm::build_info!();

    // 2. Claim the static storage and split into capabilities.
    let (receiver, motion_observer, motion) = OSSM_CELL.init(Ossm::new()).split();
    let (runner, pattern_observer, patterns) = PATTERNS_CELL.init(PatternEngine::new()).split();

    // 3. Build the (fake) hardware stack.
    let update_interval_secs = update_interval_ms / 1000.0;
    let motor = SimMotor::new();
    let board = SimBoard::new(motor, &MECHANICAL);

    let limits = MotionLimits {
        min_position_mm: 10.0,
        max_position_mm: 250.0,
        ..MotionLimits::default()
    };

    let mut controller = receiver.into_controller(board, limits, update_interval_secs);

    // 4. Spawn the 10 ms motion loop.
    let interval_us = (update_interval_secs * 1_000_000.0) as u64;
    wasm_bindgen_futures::spawn_local(async move {
        let mut ticker = Ticker::every(Duration::from_micros(interval_us));
        loop {
            if let Err(e) = controller.update().await {
                log::error!("Motion controller fault: {:?}", e);
            }
            ticker.next().await;
        }
    });

    // 5. Spawn the pattern engine loop.
    wasm_bindgen_futures::spawn_local(async move {
        runner.run(&motion, AnyPattern::all_builtin(), Delay).await
    });

    Self { motion_observer, pattern_observer, patterns }
}
```

Points worth pausing on:

**`OSSM_CELL.init(Ossm::new())`.** `StaticCell` is how you get a
`&'static mut T` safely: the cell is a static, `init` is callable exactly once
(it panics on a second call), and it hands back a unique reference with static
lifetime. That is the input `split()` demands. `MECHANICAL` is a plain
`static` with the same 20-tooth / 2 mm geometry as the hardware.

**`..MotionLimits::default()`** is struct update syntax — "these two fields,
everything else from the default". The simulator uses a 250 mm rail instead of
the hardware default 190 mm.

**`spawn_local`** is `wasm_bindgen_futures`' executor: it drives a future to
completion on the browser's microtask queue. It replaces
`spawner.spawn(motion_task(controller))` on an Embassy interrupt executor.
This is the only substantive structural difference from the firmware — and
note that both futures are *the same futures* the firmware runs.

**`async move`** — the closure takes ownership of `controller` (and of
`motion`, `runner`, `patterns` in the second). `controller` is moved into a
future that lives forever, which is why nothing else can ever touch the board
afterwards.

**`Delay`** here is `embassy_time::Delay`, the `DelayNs` implementor backed by
the wasm time driver. On hardware it is the same type name backed by a
hardware timer. The pattern's `ctx.delay_ms(500).await` therefore works
identically in both.

**No `!Send` problem.** WASM is single-threaded and `spawn_local` does not
require `Send`, which is why `&'static` handles can be shared freely between
the two spawned futures.

## What is and is not simulated

| Simulated faithfully | Not simulated |
| --- | --- |
| Motion state machine and every transition | Motor dynamics — commanded position is instantly actual |
| Ruckig trajectories, exact same limits maths | Belt stretch, backlash, mass, friction |
| Pattern logic and timing, including delays | Modbus latency, RS-485 retries, wire corruption |
| Pattern↔engine↔controller command plumbing | Homing (the sim motor "homes" by setting `position = 0`) |
| Fraction↔mm↔step conversions | Torque limits (`SimBoard::set_torque` is a no-op) |
| 10 ms tick cadence | Interrupt priorities and real-time jitter |

So it is an excellent tool for developing patterns and for validating the
control logic and state machine. It will never tell you whether your motor can
physically keep up.

## Building it

From the repo root:

```sh
just build-wasm-simulator
```

which runs, in `bindings/web-simulator`:

```sh
cargo +stable build --release
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/web_simulator.wasm
wasm-opt -O --all-features -o pkg/web_simulator_bg.wasm pkg/web_simulator_bg.wasm
echo '{"name":"@ossm-rs/web-simulator", ... }' > pkg/package.json
```

Four stages:

1. `cargo build` produces `web_simulator.wasm` — raw exports, no JS.
2. `wasm-bindgen` reads the metadata the `#[wasm_bindgen]` macro embedded in
   the module and generates `pkg/web_simulator.js` (the glue that turns the
   `Simulator` struct into a JS class), `pkg/web_simulator.d.ts` (TypeScript
   types), and a rewritten `pkg/web_simulator_bg.wasm`.
3. `wasm-opt` (from binaryen) shrinks the module.
4. The hand-written `package.json` makes `pkg/` importable as
   `@ossm-rs/web-simulator`; `apps/web-tools/package.json` links to it with
   `"link:../../bindings/web-simulator/pkg"`.

`just build-wasm` builds this and the trajectory recorder;
`just web-tools` builds both and then starts the Vite dev server with a
watcher that rebuilds the WASM when any `.rs` file under `ossm/src`,
`crates/pattern-engine/src`, `drivers/sim-motor/src`, or either binding
changes.

## Where to go next

- The other WASM module: [21-trajectory-recorder.md](21-trajectory-recorder.md)
- How JavaScript drives this: [22-web-tools-frontend.md](22-web-tools-frontend.md)
- The hardware equivalent of the constructor: [30-ossm-alt.md](30-ossm-alt.md)
