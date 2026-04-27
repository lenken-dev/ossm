# boards/

Each crate here implements [`ossm::Board`](../ossm/src/board.rs) for a specific motor-control pattern. They are HAL-agnostic - they take a `Motor` (or a more specific motor trait) and a `MechanicalConfig`, and translate position-in-mm commands into motor-specific calls. Any peripheral they need (delays, ADCs) comes through `embedded-hal` / `embedded-hal-async` traits, not a specific HAL crate. The same code runs on ESP today, on the host for tests, on WASM for the simulator, and would run on any future chip family without changes.

A board is a **dumb position follower**: it never plans motion, never decides timing, just converts mm to whatever the motor speaks. Trajectory planning happens upstream in [`MotionController`](../ossm/src/motion.rs).

## Crates

```
boards/
  rs485/        # generic RS485 board: any Rs485Motor + SelfHoming
  stepdir/      # generic step/dir board: StepDir motor + CurrentSensor for homing
  sim-board/    # in-memory board over SimMotor (used by simulator + bench tests)
```

### `rs485-board`

[boards/rs485/src/lib.rs](../boards/rs485/src/lib.rs).

`Rs485Board<M: Rs485Motor + SelfHoming>` - takes any motor that:

- implements `Motor` (basic position/enable),
- adds `Rs485Motor` (currently `set_dir_polarity` for orientation),
- and implements `SelfHoming` (the motor knows how to home itself).

The 57AIM is the only motor that fits today.

`home()` sets the direction polarity from `MechanicalConfig.reverse_direction`, then delegates to the motor's `home()` (the motor crawls and detects stall internally). `set_torque()` scales the motor's `max_output` register. `tick()` is a no-op - RS485 motors don't need polling housekeeping.

### `stepdir-board`

[boards/stepdir/src/lib.rs](../boards/stepdir/src/lib.rs).

`StepDirBoard<M: StepDir, C: CurrentSensor, D: DelayNs>` - takes a step/dir-driven motor and a current sensor (an ADC reading the motor driver's analog current output). Homing is hardware-agnostic: calibrate offset, crawl in a fixed direction at `crawl_mm_per_poll` increments, watch for current spikes above `current_threshold`. When a spike is detected, zero the position. The motion controller then moves to `min_position_mm`.

`set_torque()` is a no-op - step/dir drivers limit current in hardware. `HomingConfig` is exposed so a contributor can tune crawl speed, current threshold, calibration sample count, and timeout.

This is how the original OSSM hardware (with a TB67 driver and an ACS712 current sensor) homes.

### `sim-board`

[boards/sim-board/src/lib.rs](../boards/sim-board/src/lib.rs).

Wraps [`SimMotor`](../drivers/sim-motor/src/lib.rs). Consumed by `bindings/web-simulator` and any future test harness. Lives outside the firmware crates so it can be `cdylib`'d into the WASM build.

## When to add a new board

- A new motor protocol (CAN, EtherCAT, SPI servo). Implement [`Board`](../ossm/src/board.rs).
- A different homing strategy on existing hardware (e.g. limit switches instead of current sensing). New crate is fine; don't bolt it onto an existing board's `home()` with feature flags.

## What a `Board` impl must do

From the trait doc on [board.rs](../ossm/src/board.rs):

1. `enable()` - configure the motor for max tracking speed and accept position commands.
2. `disable()` - reject movement requests.
3. `home()` - establish position zero, however the hardware allows.
4. `set_position(mm)` - convert mm to motor units and command the motor immediately. Called every 10ms.
5. `set_torque(fraction)` - translate the fraction to motor-specific units (or no-op if the hardware doesn't support it).
6. `position_mm()` - read back current position (Modbus register read or step counter).
7. `tick()` - housekeeping called before each `set_position`. No-op if there's nothing to do. Errors here trigger a fault.

A board's `Error` type wraps the motor's error type and any board-specific failures (e.g. current sensor read failure, homing timeout). Use a sum type, don't `Box<dyn Error>`.

## What a board should not do

- Import `esp-hal` or any other HAL. If you need a delay, take `impl DelayNs`. If you need an ADC, take `impl embedded_hal::adc::*`. The chip-family glue crate adapts the real peripheral to that trait.
- Assume an executor or core layout. Boards run wherever the firmware spawns them.
- Allocate on the motion path. Same `no_std` discipline as the core.
