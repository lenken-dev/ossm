# .agent/

This directory is the agent's manual for the OSSM-rs repository. Everything here is written for AI agents and the humans using them.

## What OSSM-rs is

OSSM is a sex machine. The hardware is a stepper-driven linear actuator that strokes a toy back and forth. The firmware controls the motor. This repository is a Rust rewrite of that firmware, plus the tooling around it (web simulator, web flasher, docs site, BLE/ESP-NOW remotes).

The subject matter is adult, and the code uses the direct names that go with it. Patterns are called things like "Stop'n'Go" and "Teasing Pounding"; variables describe stroke depth and velocity. Read and write code accordingly.

## Current chip focus

Today every shipping firmware target is an ESP chip (ESP32 and ESP32-S3). That is not a long-term constraint. The core (`ossm/`), boards, drivers, transports, and pattern engine are HAL-agnostic - they speak `embedded-hal` / `embedded-hal-async` traits and don't import `esp-hal`. Chip-specific code is confined to two places: the per-family glue crate (`ossm-esp/` today) and the per-chip-family firmware workspace (`firmware/esp32/`, `firmware/esp32s3/`). Adding an RP2040, nRF, or STM32 target later means adding a sibling glue crate (e.g. `ossm-rp/`) and a sibling firmware workspace - not editing the core. Don't write code that bakes ESP assumptions into anything outside those two places.

## How to use this directory

1. **Read [philosophy.md](philosophy.md) before changing code.** It lists the rules that decide whether a change is accepted. Each hard rule has a slug (e.g. `#single-planner`) you can cite in PRs.
2. **Read [architecture.md](architecture.md)** for the layered overview and data flow.
3. **Read the area file for the directory you're touching.** Each one explains the contract that crate has to satisfy and the constraints it operates under.
4. **Use [workflow.md](workflow.md)** for build/flash/test commands. Validate via `just`, not raw `cargo`.
5. **Use [conventions.md](conventions.md)** for naming, comments, ASCII-only punctuation, American English.

If a request would violate something in `philosophy.md`, raise it with the user before doing it.

## Files

### Project-wide
- [philosophy.md](philosophy.md) - design rules, what gets accepted vs rejected
- [architecture.md](architecture.md) - layered overview, data flow, why the layers exist
- [workflow.md](workflow.md) - `just` recipes, `just focus`, doctor, dev loops
- [conventions.md](conventions.md) - naming, comments, code style, ASCII-only, US English

### Per area
- [ossm.md](ossm.md) - the core `no_std`, HAL-agnostic crate: motion controller, motor traits, transports, planner, state
- [ossm-esp.md](ossm-esp.md) - ESP-specific glue (UART, RS485 driver, board/motor wiring) shared by all ESP firmware. Sibling crates would be added per chip family (e.g. `ossm-rp/`) - this one is not the abstraction, it's one implementation of it.
- [boards.md](boards.md) - `Board` impls: `rs485`, `stepdir`, `sim-board`. HAL-agnostic; take `embedded-hal` traits.
- [drivers.md](drivers.md) - `Motor` impls: `m57aim` (RS485 + step/dir), `sim-motor`. HAL-agnostic.
- [pattern-engine.md](pattern-engine.md) - the `Pattern` trait, the engine state machine, built-in patterns
- [remotes.md](remotes.md) - BLE (RADR) + ESP-NOW (legacy OSSM M5) remote crates. Currently use `esp-radio`; the wire formats and command layer are HAL-agnostic.
- [firmware.md](firmware.md) - per-chip-family firmware workspaces. Today: `firmware/esp32`, `firmware/esp32s3`. **Independent workspaces, not root members.**
- [bindings.md](bindings.md) - `web-simulator`, `trajectory-recorder` (WASM bindings consumed by `web-tools`)
- [web-tools.md](web-tools.md) - Vite/React app: simulator, trajectory grapher, web flasher
- [docs.md](docs.md) - Next.js/Nextra docs site published to `ossm-rs.com`

## Keeping this directory honest

These files will rot if no one minds them. **If you change a directory's structure, contracts, or load-bearing details, update the matching area file in the same PR or call out the drift.** Don't let this directory and the codebase diverge silently - an out-of-date manual is worse than no manual.

When the repo grows a new top-level area, add a new file here and link it from the index above.

User-facing documentation lives in [docs/](../docs/), not here. This directory is the AI manual.
