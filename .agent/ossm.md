# ossm/

The core crate. Public API, motion controller, hardware traits, transports, planner. `no_std`, HAL-agnostic, no chip-specific code. Today it builds for ESP32, ESP32-S3, `wasm32-unknown-unknown`, and the host; it should build for any other target with `embedded-hal-async` support without further changes.

This is the most carefully designed crate in the repo. **Don't change its trait surface without a good reason.** Every other crate is downstream.

## Public surface

[ossm/src/lib.rs](../ossm/src/lib.rs) re-exports:

- `Ossm` - the public command channel handle.
- `MotionController` - the runtime that consumes commands.
- `Board` (trait) - what every board crate has to implement.
- `Motor`, `Rs485Motor`, `StepDir`, `CurrentSensor`, `SelfHoming` - motor traits.
- `MotionLimits`, `MechanicalConfig` - configuration types.
- `MotionCommand`, `StateCommand`, `StateResponse`, `Cancelled` - command types.
- `MotionState`, `MotionPhase` - observable state.
- `transport::*` - Modbus, Modbus RTU, step/dir transports.

A typical user creates one `Ossm` (a `static`), calls `.controller(board, limits, dt)` to get a `MotionController`, spawns the controller as a task, and then drives the machine through `Ossm`'s methods (`enable`, `home`, `begin_motion`, `update_motion`, `await_motion`, `motion_state`, `phase_subscriber`).

## Key design points

### `Ossm` is a thin handle, not the engine
`Ossm` only owns `OssmChannels` (an `embassy_sync` channel + a few signals). `Ossm::controller()` builds the `MotionController` that actually runs. This separation lets the controller live on a different core/task than the callers, with no shared mutable state.

`Ossm::new()` is `const`, so it can be a `static`. The controller is created once per process, at startup.

### `MotionController` is the only planner
See [board.rs](../ossm/src/board.rs) and the philosophy rule on a single planner. The controller owns the Ruckig instance, the state machine, the `MotionLimits`, and the trajectory parameters. Every other layer follows positions.

### State transitions are explicit
`MotionController::process_state_command` is a giant `match (state, cmd)`. Add new states and commands here, not in scattered `if` branches. Idempotent transitions (`Enabled` + `Enable`) and "respond `InvalidTransition`" catch-alls are deliberate. See the comment about RADR thrashing - it explains why idempotent enable is allowed.

### Pause/resume keeps the target alive
`MotionTarget` is the user-instructed intent, separate from what Ruckig is currently planning. Pause switches Ruckig to velocity control with target 0, so it decelerates jerk-limited. Resume re-enters position control and replans to the saved target. `enter_fault()` clears the target.

### Telemetry is published, not pulled
The controller writes `MotionState` to a `Cell<MotionState>` behind a `CriticalSectionRawMutex` every tick. Subscribers read it any time without blocking. Phase transitions also publish to a `PubSubChannel<MotionPhase>` so subscribers can `.await` for transitions without polling.

### Transports are bring-your-own
`transport::Modbus` is protocol-only; it doesn't know about RS485. `Rs485ModbusTransport` adds RS485 framing on top. `StepDirMotor` is the step/dir analog. Adding a new bus (CAN, SPI) means writing a transport, not editing the controller.

## When to change this crate

- Adding a new motor capability the board needs to call. Put it on a new sub-trait like `Rs485Motor` rather than bloating `Motor`. Boards depend on the union of traits they need.
- Adding a new motion command (e.g. relative move, velocity-only, multi-axis). Update `MotionCommand`, the controller's `process_move_command`, and `Ossm::begin_motion`.
- Adding a new state (e.g. `Recovering`, `Calibrating`). Add it to both `MotionState` (private, in motion.rs) and `MotionPhase` (public, in state.rs), and route transitions through `transition()`.

## When **not** to change this crate

- Chip-specific peripheral wiring. That's the per-family glue crate (`ossm-esp/` for ESP). If you reach for `esp-hal` (or any other HAL crate) here, stop.
- Pattern logic. That's `crates/pattern-engine/`.
- Adding a `std::` import. This is `no_std`.
- Adding a dependency to talk to a specific motor. That goes in a driver crate.
- Anything that wouldn't compile on a non-ESP target. The simulator and host builds catch most of these; new chip families will catch the rest.
