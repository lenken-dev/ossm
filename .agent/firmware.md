# firmware/

Per-chip-family firmware crates. Each one assembles `ossm`, the per-family glue crate (`ossm-esp/` for ESP today), `pattern-engine`, and the remotes into a flashable binary for one chip family.

```
firmware/
  esp32/         # ESP32 (xtensa, dual-core). Step/dir motor (OSSM Reference Board).
  esp32s3/       # ESP32-S3 (xtensa, dual-core). RS485 motor (OSSM Alt, Waveshare, Seeed XIAO).
```

ESP is the only family with firmware today. A future RP2040 / nRF / STM32 port would live alongside as `firmware/<family>/`, with its own glue crate (`ossm-rp/`, `ossm-nrf/`, ...). The structure below is the model.

## Important: these are independent workspaces

Each firmware crate has its own `[workspace]` table with `members = ["."]`. They are **not** members of the root [Cargo.toml](../Cargo.toml) workspace. Same goes for the per-family glue crate.

Why: each chip family pins a different toolchain and target triple. Today that's `+esp` xtensa for both ESP firmwares. If they were root members, every crate in the repo would have to compile with that toolchain, breaking the WASM bindings and host builds. The same constraint applies to any future chip family - its toolchain pin would clash with someone else's.

This is the single most important thing to remember when working in this directory:
- Don't add `firmware/*` to the root workspace `members`.
- `ossm-esp/` is also its own workspace (`[workspace] members = ["."]`), not a root member. Both ESP firmware crates pick it up as a path dep and select a chip via the `esp32` / `esp32s3` features. Keep ESP-specific glue here rather than at the root, where it would force the rest of the repo through `+esp`. A future per-family glue crate follows the same rule.
- `cargo` commands in `firmware/<crate>/` need the right toolchain (`+esp` today; the [justfile](../justfile) handles this).
- `Cargo.lock` is per firmware crate. Don't try to share it.

## What each firmware crate does

Both ESP crates follow the same pattern. A future chip-family firmware should match this shape - the names of the glue crate and HAL change, the structure does not.

1. `bin/<board>.rs` - the entrypoint. Initialises the chip HAL (today: ESP), fills in pins/peripherals into a `Config` struct, calls into `lib::run(spawner, config)`. There's one `bin` per supported PCB.
2. `lib.rs` - constructs `Ossm`, `MotionController`, the board, the radio stack, and the `PatternEngine`. Spawns the motion task on a high-priority executor (interrupt executor pinned to core 1 on ESP). Runs the pattern engine's runner on the main task.
3. `board.rs` / `motor.rs` - thin shims over the per-family glue crate (`ossm-esp` today) that pick the concrete board/motor type for this chip family.
4. `radio.rs` - boots the BLE / ESP-NOW radio and starts the remote tasks. Chip-family-specific.
5. `partitions.csv` - flash partition table. The bootloader is `esp-bootloader-esp-idf`. ESP-specific - other families won't have this file.
6. `build.rs` - calls into the per-family build-support crate (`ossm-esp-build-support` today) for partition table and linkage helpers.

## Memory budgets

These are per-chip and live in the firmware crate, not in `ossm/` or any HAL-agnostic crate.

- ESP32: 64KB heap, 32KB app-core stack. ESP-NOW dropped to fit BLE. Comment in [firmware/esp32/src/lib.rs](../firmware/esp32/src/lib.rs) explains why.
- ESP32-S3: 128KB heap, 32KB app-core stack. BLE + ESP-NOW + Wifi all fit.

The 32KB stack is sized for Ruckig's heavy float math. Don't size it down. This budget travels with the planner, not the chip - any future chip family will need a similarly sized stack for the motion task.

## Adding a new PCB

1. Pick the chip family. ESP32-S3 unless there's a strong reason.
2. Decide on the motor interface. RS485 is preferred. If step/dir, use `firmware/esp32`.
3. Create a new bin under `firmware/<chip>/src/bin/<name>.rs` modeled on `ossm-alt.rs`. Fill in the right peripheral and pin assignments.
4. Add `[[bin]]` entries to [firmware/<chip>/Cargo.toml](../firmware/esp32s3/Cargo.toml).
5. Add `build-<name>` and `flash-<name>` recipes to the [justfile](../justfile). Add `<name>` to `build-all`.
6. If the board needs new wiring helpers (e.g. a different RS485 chip, an extra GPIO), put them in the matching per-family glue crate ([ossm-esp/](../ossm-esp) for ESP), not in the firmware crate.

## Adding a new ESP chip variant

For other ESP chips (ESP32-C6, ESP32-H2, ...) within the existing ESP family:
- Add a feature on [ossm-esp/Cargo.toml](../ossm-esp/Cargo.toml) (`esp32c6`, etc.) gating the matching `esp-hal` feature.
- Reuse `firmware/esp32/` or `firmware/esp32s3/` if the architecture matches, or create a new ESP firmware workspace if it doesn't (e.g. RISC-V chips need a different toolchain pin).
- Confirm `esp-radio`, `esp-rtos`, `esp-hal` all support that chip with the features we use.
- A bin file for at least one PCB.

## Adding a new chip family (non-ESP)

This is heavier - it's a new HAL surface, not a new chip variant. You need:

- A new per-family glue crate at the repo root (e.g. `ossm-rp/` for RP2040), modeled on `ossm-esp/`. Its own workspace, not a root member. It owns the chip-family HAL imports (`rp-hal`, `embassy-rp`, etc.) and exposes `Config` structs + `build()` functions to the firmware. **Nothing outside this crate and the matching `firmware/<family>/` should import that HAL.**
- A `firmware/<family>/` workspace with the right toolchain pin and target triple. Independent workspace, same rule as the ESP firmware crates.
- A radio story, if applicable. The current `crates/ble-remote` is wired to `esp-radio`; on a different chip, either gate it behind features or extract a HAL-agnostic GATT layer over a different BLE driver. Coordinate this with the user before doing it.
- A bin file for at least one PCB and matching `just` recipes.

Existing boards (`boards/*`) and drivers (`drivers/*`) should compile against the new family without changes - they only consume `embedded-hal` traits. If something doesn't, that's a sign the abstraction needs fixing rather than working around in the firmware.

Don't bring up a new chip family without a real board to flash; speculative ports go stale.
