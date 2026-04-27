# Philosophy

The rules that shape what gets accepted into this project. Read this before proposing or making changes. If a request runs into one of these, raise it with the user and explain the trade-off rather than quietly working around it.

Each hard rule below has a short slug (e.g. `#single-planner`) so it can be cited in PRs and reviews ("violates `#single-planner`"). Use them.

## What this project is for

A safer, more modular, more testable replacement for the original C++ OSSM firmware. The win is not raw feature count - it's that the design lets contributors add a pattern, motor, or board without understanding the whole system, and lets us catch bugs before the hardware moves.

Every design decision below serves one of: **safety**, **modularity**, **testability**, **portability**.

## Hard rules

These have load-bearing reasons behind them. Don't change them without a discussion.

### 1. Trajectory planning happens in exactly one place {#single-planner}

The `MotionController` (in [ossm/src/motion.rs](../ossm/src/motion.rs)) owns Ruckig and is the only thing that plans motion. Every other layer is a position follower.

- A `Board` receives a position in millimeters each tick and commands the motor to that position. It does not plan.
- A `Motor` receives an absolute position in steps and tracks it. Internal trajectory planners on the motor (e.g. the 57AIM has one) are configured for maximum tracking speed so they act as pure servos.
- Patterns produce target positions. They do not plan motion either - they ask `Ossm` to go somewhere and `await` completion.

**Why:** two trajectory planners in series produce unpredictable compounding behavior. Centralizing planning in one place is also what makes the safety enforcement (max velocity, accel, jerk) meaningful.

**Watch out for:** smoothing logic creeping into a pattern, or "the motor's onboard planner can handle the deceleration" arguments. Both reintroduce the exact problem this rule prevents.

### 2. Motion limits are enforced in the controller, not at the edges {#controller-clamps}

`MotionLimits` (max velocity, accel, jerk, position range) live on the controller and are fed straight into Ruckig. Upstream code can ask for anything; the controller clamps it. Patterns, remotes, the web UI - none of them are trusted.

**Watch out for:** clamping only at the pattern level. Clamps higher up are useful for UX (don't show a slider that goes past the limit), but the controller still has to clamp - it's the only thing that sees every command.

### 3. The public API speaks fractions {#fractional-api}

`MotionCommand` uses `position` and `speed` as `0.0..=1.0` fractions of the configured range, not millimeters. Patterns, remotes, and UIs work in these units.

**Why:** a pattern that strokes between 0.0 and 1.0 should work on a machine with 100mm travel and a machine with 250mm travel without changing. Geometry is a per-machine concern; patterns are not.

**Watch out for:** mm leaking into a pattern, motor, or remote. mm only exists below the controller.

### 4. The core crate is `no_std` and HAL-agnostic {#portable-core}

`ossm/` has no chip-specific code, no `std`, no allocation in the hot path beyond what Ruckig needs. It compiles to ESP32, ESP32-S3, and `wasm32-unknown-unknown` (used by the web simulator), and should compile to any other target with `embedded-hal-async` support without further work.

The boards (`boards/*`), drivers (`drivers/*`), pattern engine (`crates/pattern-engine`), and transports (`ossm/src/transport`) are also HAL-agnostic. They depend on `embedded-hal` / `embedded-hal-async` traits, not on a specific HAL crate. The wire-format layer of the remotes (`crates/ble-remote`, `crates/ossm-m5-remote`) is HAL-agnostic too; the radio drivers they consume happen to be ESP today.

Chip-specific code is confined to two places:

- The per-family glue crate (`ossm-esp/` for ESP today; the slot for an `ossm-rp/`, `ossm-nrf/`, etc. tomorrow). This is where a HAL implementation gets adapted to the traits in `ossm/`.
- The matching firmware workspace (`firmware/esp32/`, `firmware/esp32s3/`). This is where pins, peripherals, and the static layout are decided for a specific board.

ESP is the current focus, not the contract. Don't add code that assumes ESP outside those two locations.

**Watch out for:** `esp-hal`, `esp-radio`, `esp-rtos`, or `std` showing up in `ossm/`, `pattern-engine/`, any board/driver crate, or any binding. If a feature genuinely needs HAL specifics, push the chip-specific part into `ossm-esp/` (or its sibling for that family) and expose a HAL-agnostic surface upward.

### 5. Async, lock-free, Embassy {#lock-free-motion-path}

Communication between the public `Ossm` API, the motion controller, the pattern engine, and remotes happens through `embassy_sync` channels, signals, and pubsub - never locks on the motion path. On the ESP firmware the motion task runs on a high-priority interrupt executor on its own core; on a single-core or differently structured chip family, the firmware picks the closest equivalent. The contract is "high priority and not blocked by application code", not "core 1".

**Watch out for:** a `Mutex` that the motion loop has to wait on. A channel or a `Cell` behind a `CriticalSectionRawMutex` is almost always the better fit.

### 6. Trait-based hardware abstraction {#trait-hardware}

`Board` and `Motor` are traits ([ossm/src/board.rs](../ossm/src/board.rs), [ossm/src/motor/mod.rs](../ossm/src/motor/mod.rs)). Concrete implementations live in `boards/` and `drivers/`. Adding a new board or motor means writing a new impl, not editing the controller.

**Watch out for:** `if board == "stepdir" { ... }` style branching in the core. If you find yourself reaching for one, the abstraction needs extending instead.

### 7. Firmware crates are independent workspaces {#firmware-workspaces}

[firmware/esp32/](../firmware/esp32) and [firmware/esp32s3/](../firmware/esp32s3) each have their own `Cargo.toml` workspace with `members = ["."]`. They are **not** members of the root workspace. Any future per-chip-family firmware crate (e.g. `firmware/rp2040/`) follows the same pattern. So does the per-family glue crate (`ossm-esp/`).

**Why:** each chip family pins a different toolchain (today, `+esp` xtensa) and a different target triple. Root workspace membership would force every other crate through that toolchain, breaking the WASM and host builds. Keeping firmware and chip-family glue out of the root workspace is what lets the same `ossm/`, boards, drivers, and pattern engine compile cleanly for ESP, WASM, and host - and tomorrow for any other chip family someone adds. `just focus <crate>` switches rust-analyzer between them.

**Watch out for:** suggestions to merge them into the root workspace, or to add `esp-hal` (or any other HAL) as a root-workspace dependency. Both reintroduce the toolchain coupling this rule prevents.

### 8. Patterns must be cancelable {#cancelable-patterns}

Patterns are async loops that call `ctx.motion().position(...).send().await?`. The `?` propagates `Cancelled` when the controller stops the in-flight motion (disable, home, pause). A pattern that swallows `Cancelled` or runs blocking work without `await` points won't stop when the user asks it to.

**Watch out for:** `let _ = send.await;` in a pattern. Cancellation needs to bubble all the way up to the runner.

### 9. Telemetry is an opportunity, not a feature parity exercise {#telemetry-asymmetry-ok}

RS485/Modbus motors expose live position, current, voltage, temperature. The architecture is built so we can use this for safety (stall detection, overcurrent shutdown). Step/dir boards have less to work with, and that's fine - they get current-sense homing and that's enough.

**Watch out for:** "the step/dir path doesn't have temperature, so let's not bother adding it on RS485 either." Asymmetry between boards is acceptable; capability ceilings imposed by the weakest one are not.

### 10. The pattern engine is a substrate, not a curated set {#pattern-substrate}

The seven built-in patterns ([crates/pattern-engine/src/patterns/](../crates/pattern-engine/src/patterns)) are examples. Contributors are expected to add their own. Keep the `Pattern` trait minimal so this stays easy.

## Soft preferences

These are defaults, not commandments. Push back if a situation genuinely warrants the other choice.

- **Small focused crates** beat one big crate. The split between `ossm`, `ossm-esp`, `boards/*`, `drivers/*`, `crates/*`, `bindings/*` is deliberate.
- **Reuse the simulator.** New patterns, new motion-shaped features - run them in [apps/web-tools](../apps/web-tools) before flashing. The simulator uses the same `ossm` crate, so behavior matches.
- **Logs are cheap, panics are not.** Use `log::error!` and transition to a safe state. The controller's `enter_fault()` is the model.
- **Don't add features the user didn't ask for.** This applies to firmware (no speculative drivers) and to patches (no surprise refactors).

## What to flag, not just fix

If you spot one of these while doing other work, mention it rather than quietly cleaning it up - some of them might be intentional, and the user will want to weigh in:

- A new dependency in `ossm/`, `pattern-engine/`, or a board/driver crate.
- A `MotionCommand` somewhere upstream of the controller that uses mm.
- A `std::` import in a `no_std` crate.
- A trajectory calculation outside the controller.
- A panic path on the motion loop.
- An `esp-hal` / `esp-radio` / `esp-rtos` import outside `ossm-esp/` or `firmware/*`. Same flag applies to any other HAL crate in the future.

These look small in a diff but break the design rules above.
