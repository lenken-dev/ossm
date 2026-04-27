# drivers/

Each crate here implements the [`Motor`](../ossm/src/motor/mod.rs) trait (and possibly `Rs485Motor`, `StepDir`, `CurrentSensor`, `SelfHoming`) for a specific motor. Drivers are HAL-agnostic - they speak through the `transport` traits in [ossm/src/transport](../ossm/src/transport) and `embedded-hal` traits, so the same driver runs on ESP, on the host for tests, in WASM for the simulator, and on any future chip family without changes.

A driver's job is to implement the motor's protocol. It should not care which UART, which board, which chip, or which trajectory.

## Crates

```
drivers/
  m57aim/        # JMC 57AIM series stepper-servo, RS485 (Modbus RTU) or step/dir
  sim-motor/     # in-memory motor for the simulator and tests
```

### `m57aim-motor`

[drivers/m57aim/src/lib.rs](../drivers/m57aim/src/lib.rs).

The 57AIM is a closed-loop NEMA 23 stepper-servo with onboard control. It exposes a Modbus RTU register map ([rs485.rs](../drivers/m57aim/src/rs485.rs)) and a step/dir input mode ([stepdir.rs](../drivers/m57aim/src/stepdir.rs)).

Key registers (see `RwRegister` / `RoRegister` enums):
- `DriverOutputEnable` (`0x01`) - enables the output stage.
- `MotorTargetSpeed` / `MotorAcceleration` - configured for max tracking, since the controller is the planner.
- `DirPolarity` (`0x09`) - direction reversal, set from `MechanicalConfig.reverse_direction`.
- `AbsolutePositionLowU16` / `HighU16` (`0x16` / `0x17`) - 32-bit absolute position target. Written every tick.
- `StandstillMaxOutput` (`0x18`) - torque limit.
- `SpecificFunction` (`0x19`) - homing trigger and other one-shots.

Read-only registers expose alarm code, current, voltage, temperature, and live position. These are the basis for the safety telemetry mentioned in [philosophy.md](philosophy.md) - poll them in `Board::tick` to detect stalls or thermal runaway.

The driver's `Error` type wraps the underlying transport error.

### `sim-motor`

[drivers/sim-motor/src/lib.rs](../drivers/sim-motor/src/lib.rs).

Pure in-memory motor. Tracks an absolute position; `set_absolute_position` updates it; `read_absolute_position` returns it. `home` zeroes. No physics simulation - the simulator's "feel" comes from running the same Ruckig planner against the simulated motor, so the trajectory is identical to real hardware.

If you want a more realistic motor simulator (lag, overshoot, current draw model), this is the file to extend.

## When to add a new motor

- New protocol or new motor product. New crate. Implement `Motor`, plus `Rs485Motor` / `StepDir` / `SelfHoming` as appropriate.
- New protocol variant on an existing motor (e.g. CAN open on a 57AIM-CAN). Could be a new module in the existing crate; could be a new crate. Pick whichever keeps the dependency surface clean.

A motor that wants to self-home (motor firmware does the crawl + stall detection) implements `SelfHoming`. A motor that needs the board to do it (step/dir with a current sensor) does not.

## What a driver should not do

- Hold a UART directly. It speaks through a transport trait so the firmware decides the bus.
- Allocate. `no_std`, no `alloc`, fixed buffers.
- Import `esp-hal` (or any other HAL crate). Drivers cross-compile to host and WASM today, and to any future chip family tomorrow. If a driver "needs" HAL specifics, the right answer is almost always to push that need into the per-family glue crate (`ossm-esp/`) and keep the driver speaking traits.
