# ossm-esp/

ESP-specific glue. Sits between [ossm/](../ossm) (the HAL-agnostic core) and the ESP firmware crates ([firmware/esp32](../firmware/esp32), [firmware/esp32s3](../firmware/esp32s3)). Both firmware crates depend on this; nothing else does.

This is **the only crate outside `firmware/*` that depends on `esp-hal`.** Don't reach for `esp-hal` from anywhere else.

This crate is one slot in a wider pattern: it's the *ESP* per-family glue. A future chip family would add a sibling crate (e.g. `ossm-rp/` for RP2040) following the same shape - own the HAL imports for that family, expose HAL-agnostic `Config` + `build()` functions upward. The point of this crate is to keep `esp-hal` (and friends) out of `ossm/`, the boards, the drivers, and the patterns. Anything that needs ESP imports lives here or in firmware. Anything portable lives lower.

## What it owns

- UART setup wrapped to satisfy the transport traits in `ossm::transport`.
- An RS485 half-duplex driver that toggles a DE/RE pin around transmit.
- Builders that wire a `Motor` driver into a `Board` impl, gated by Cargo features.

## Features

```toml
esp32 = ["esp-hal/esp32"]
esp32s3 = ["esp-hal/esp32s3"]

motor-rs485   = ["dep:m57aim-motor", "dep:rs485-board"]
motor-stepdir = ["dep:m57aim-motor", "dep:stepdir-board", ...]
motor-sim     = ["dep:sim-motor", "dep:sim-board"]
```

The chip family is one feature; the motor type is another. A firmware crate picks one of each.

`motor-sim` overlays the simulated motor in place of the real one. It's still under the `ossm-esp` builder so the firmware bin file doesn't change between real and sim builds - the sim layer drops the unused fields (UART pins etc.) inside `build()`. See the comment in [firmware/esp32s3/Cargo.toml](../firmware/esp32s3/Cargo.toml) about why `motor-sim` pulls in `motor-rs485`.

The crate is laid out as `src/{uart,rs485}.rs` plus a `motor/` and `board/` module - one file per `motor-*` feature variant inside each. There's also a sibling [build-support/](../ossm-esp/build-support) crate consumed via `[build-dependencies]` for the partition table and `esp-bootloader` linkage.

## Patterns to follow

### Config struct + build function

Each motor variant exposes a `Config` struct that the firmware's `bin` file fills in with peripherals and pins, and a `build(cfg) -> impl Motor` function that the rest of the firmware calls.

```rust
let motor = motor::build(config.motor);
let board = board::build(motor, &MECHANICAL);
```

The same pattern at the board level. Keep this consistent - it's what lets `motor-sim` drop in without touching the bin file.

### Half-duplex RS485

The RS485 driver in [rs485.rs](../ossm-esp/src/rs485.rs) flushes after asserting DE, transmits, waits for the byte queue to drain, then deasserts DE before reading. Modbus RTU with no CRC errors and no missed responses depends on getting this timing right - if a contributor reports flaky reads, this is usually the place to look.

### Build support crate

[ossm-esp/build-support](../ossm-esp/build-support) is a separate crate consumed via `[build-dependencies]`. It hosts `build.rs` logic shared by both firmware crates so a `build.rs` change doesn't have to be made twice.

## When to change this crate

- New ESP chip variant (ESP32-C6, etc.). Add a feature, gate the `esp-hal/esp32cN` feature behind it, and confirm the radio crates have matching support.
- New motor wiring on ESP (e.g. CAN). Add a `motor-can` feature and a `motor/can.rs` builder.
- UART tuning - baud rates, timeout values, flush behavior for a specific motor on ESP UARTs.

## When not to

- Pin assignments. Those belong in the firmware bin file ([firmware/esp32s3/src/bin/ossm-alt.rs](../firmware/esp32s3/src/bin/ossm-alt.rs)) - that's where the user knows the actual hardware.
- Anything HAL-agnostic. Push it down into [ossm/](../ossm), the boards, or the drivers so the simulator and any future chip family see it too. If a piece of logic is HAL-agnostic but currently sits here for convenience, that's a flag.
- Wiring for a non-ESP chip family. That goes in a sibling glue crate (e.g. `ossm-rp/`), not by widening this one.
- Pattern code. Patterns are HAL-agnostic and live in [crates/pattern-engine/](../crates/pattern-engine).
