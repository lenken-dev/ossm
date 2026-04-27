# Architecture

How the layers fit together and why each one exists. Read this after [philosophy.md](philosophy.md).

## The layers (top down)

| Layer            | What lives there                                                     | Notes                                                                       |
| ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Apps             | `web-tools`, `docs`                                                  | TypeScript, Vite + React, Next.js + Nextra                                  |
| Bindings         | `web-simulator`, `trajectory-recorder`                               | `wasm-bindgen` packages consumed by `web-tools`                             |
| Firmware         | `firmware/esp32`, `firmware/esp32s3` (today; one workspace per chip family) | Per-chip-family binaries, independent workspaces. Pin pins, peripherals, toolchain. |
| Chip-family glue | `ossm-esp/` (today; sibling crates per future family)                | Adapts a HAL to the `ossm` traits. ESP-only crates (`esp-hal`, `esp-radio`) live here or in firmware. |
| Features         | `pattern-engine`, `ble-remote`, `ossm-m5-remote`                     | `no_std` crates that talk to `Ossm`. Wire formats are HAL-agnostic; radio drivers are ESP today. |
| Public API       | `ossm::Ossm`                                                         | Send commands, observe state. HAL-agnostic.                                 |
| Controller       | `ossm::MotionController`                                             | Ruckig, state machine. HAL-agnostic.                                        |
| Board            | `boards/{rs485,stepdir,sim}`                                         | `trait Board`. HAL-agnostic; takes `embedded-hal` traits.                   |
| Motor            | `drivers/{m57aim,sim-motor}`                                         | `trait Motor` (plus `Rs485Motor` / `StepDir`). HAL-agnostic.                |
| Transport        | `ossm::transport` (Modbus, Modbus RTU, step/dir)                     | How bytes get to the motor. HAL-agnostic.                                   |

**Read the layer table top-down for "where does this go?".** Anything HAL-agnostic stays in the bottom seven layers. Anything that needs a specific HAL belongs in one of the top two.

## What flows where

### Down: commands

A pattern calls `ctx.motion().position(0.5).send().await?`.

1. The pattern's builder converts the fraction into a `MotionCommand` using the live `PatternInput` (depth, stroke, velocity, sensation).
2. `Ossm::begin_motion` sends the `MotionCommand` over an `embassy_sync::channel` to the motion task.
3. The motion task is `MotionController::update()` running every `UPDATE_INTERVAL_SECS` (10ms by default). On the ESP firmware it runs on a high-priority interrupt executor on core 1; the same loop runs on whatever executor the host firmware sets up on a different chip family.
4. The controller's state machine accepts the command if it is in `Ready` or `Moving`. It clamps the request to `MotionLimits`, converts the fraction to mm, writes it to Ruckig as the new target, and resets Ruckig's trajectory timer.
5. Each tick, the controller advances Ruckig and calls `board.set_position(mm)`. Ruckig produces a jerk-limited trajectory between current and target.
6. The board converts mm to motor steps via `MechanicalConfig::mm_to_steps` and sends the absolute position to the motor.
7. The motor (e.g. 57AIM over RS485) tracks the commanded position. The motor's own planner is configured for max tracking speed, so it acts as a servo, not a planner.

When the motion completes, the controller signals `move_resp`. The pattern's `send().await` returns `Ok(())` and the pattern requests the next position.

### Up: state and cancellation

- The controller publishes `MotionState` (phase, position, velocity, accel, torque) every tick to a `Cell` behind a `CriticalSectionRawMutex`.
- Phase transitions are also published on a `PubSubChannel<MotionPhase>` so subscribers (BLE remote, simulator) get notified.
- A state command (`disable`, `home`, `pause`) cancels any in-flight motion by signaling `move_resp` with `Err(Cancelled)`. The pattern's `?` propagates this and the pattern engine's runner re-enters `Idle`.

## State machine

The controller has six states, defined in [ossm/src/motion.rs](../ossm/src/motion.rs):

```
Disabled --enable--> Enabled --home--> Ready --move--> Moving
   ^                    |                |               |
   |                    +--disable-------+               |
   |                                                     |
   |                                                     v
   +<--disable--Stopping(Disable)<--disable--+--pause--> Stopping(Pause) --> Paused
                                             |                                |
                                             +--home--> Stopping(Home)        |
                                                              |               |
                                                              v               |
                                                            Ready <-----------+
                                                                  resume
```

Key rules:

- Pause/disable while moving go through a `Stopping(reason)` substate. Ruckig switches to velocity control with target velocity 0 and decelerates with the configured jerk limit. Stopping is **not** instantaneous.
- Pause preserves the instructed target. Resume re-enters position control and replans to the same target.
- `enter_fault()` is the path when `board.tick()` returns an error. It cancels in-flight responses and forces `Disabled`.

## Why the public API is fractions

`MotionCommand { position, speed, torque }` carries `f64` fractions in `0.0..=1.0`. The controller multiplies them by `MotionLimits.max_*` to get physical units.

This means:

- A pattern that strokes between `position(0.0)` and `position(1.0)` works on any machine.
- The pattern engine's `PatternInput { depth, stroke, velocity, sensation }` further scales those fractions: position 1.0 means "deepest" within the user's chosen depth/stroke envelope.
- All UIs (web simulator, BLE remote app) bind their sliders to fractions directly.

mm exists below the controller. The board's `MechanicalConfig` (pulley teeth, belt pitch, reverse) translates mm to motor steps.

## Concurrency model

- **Motion task**: `MotionController::update()` on a high-priority interrupt executor (core 1 on dual-core ESPs). Fixed 10ms tick. On a different chip family, the firmware decides which executor and core - the controller doesn't care.
- **Application task**: pattern engine runner, started after motion is up. Drives patterns by awaiting on motion completion.
- **Radio tasks**: BLE GATT server, ESP-NOW receiver. Spawned by the firmware. Talk to the pattern engine and to `Ossm` via channels. Today these use `esp-radio`; the wire formats are HAL-agnostic.
- **No locks on the motion path.** All cross-task communication is `embassy_sync::channel`, `Signal`, or `PubSubChannel`. Shared `MotionState` lives in a `Cell` behind a `CriticalSectionRawMutex` so reads from any core are wait-free.

## Where the layers live

- `ossm/` - the core. Public API (`Ossm`), controller, traits, transports. `no_std`, HAL-agnostic, no allocation in hot paths. Compiles for any target with `embedded-hal-async` support.
- `ossm-esp/` - ESP-specific glue. UART setup, RS485 half-duplex driver, board/motor builders gated by `motor-rs485` / `motor-stepdir` / `motor-sim` features. Used by both ESP firmware crates. **This is the per-family glue slot** - a future RP2040 port would add an `ossm-rp/` next to it, not extend this crate.
- `boards/` - `Board` impls. `rs485` (any `Rs485Motor + SelfHoming`), `stepdir` (any `StepDir + CurrentSensor`), `sim-board` (drives the `SimMotor`). HAL-agnostic.
- `drivers/` - `Motor` impls. `m57aim` (Modbus RTU over RS485, also step/dir mode), `sim-motor` (in-memory). HAL-agnostic.
- `crates/pattern-engine` - `Pattern` trait, `PatternEngine`, `PatternEngineRunner`, `PatternInput`, the seven built-in patterns. HAL-agnostic.
- `crates/ble-remote` - GATT server for the RADR BLE remote. Uses `esp-radio` for the radio driver today; the GATT layer and command parsers are HAL-agnostic.
- `crates/ossm-m5-remote` - ESP-NOW receiver for the OSSM-M5 remote. ESP-NOW is an ESP-specific protocol, so this crate is ESP-bound by design.
- `firmware/esp32`, `firmware/esp32s3` - per-chip binaries for the ESP family. **Independent workspaces.** Each has its own `Cargo.lock`. A future chip family (e.g. RP2040) would live alongside as `firmware/<family>/`, with the same independent-workspace rule.
- `bindings/web-simulator`, `bindings/trajectory-recorder` - WASM. Run the same `ossm` + `pattern-engine` code in the browser.
- `apps/web-tools` - Vite/React app: web simulator UI, trajectory grapher, web flasher, PR firmware testing UI.
- `apps/docs` - Next.js/Nextra docs site.
- `reference/` - git submodules: an earlier Rust port (`orange-gem/ossm-rs`), the M5 remote firmware (`ortlof/OSSM-M5-Remote`), the OSSM hardware + reference C++ firmware repo (`KinkyMakers/OSSM-hardware`), and the RADR remote firmware (`researchanddesire/radr-wireless-remote`). Read-only references for protocol and pin details.

## Reading order if you've never seen this code

1. [ossm/src/lib.rs](../ossm/src/lib.rs) - the public surface in 130 lines.
2. [ossm/src/board.rs](../ossm/src/board.rs) - the contract a board has to satisfy.
3. [ossm/src/motion.rs](../ossm/src/motion.rs) - the state machine.
4. [crates/pattern-engine/src/pattern.rs](../crates/pattern-engine/src/pattern.rs) - how patterns produce commands.
5. [firmware/esp32s3/src/lib.rs](../firmware/esp32s3/src/lib.rs) - how it all gets assembled.
