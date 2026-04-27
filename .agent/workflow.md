# Workflow

Build, flash, run, and develop. All commands are `just` recipes; see [justfile](../justfile) for the source.

## Validate via `just`, not raw `cargo`

Before declaring work done, validate it with the relevant `just` recipe rather than `cargo build` or `cargo check`. The recipes:

- Source `~/export-esp.sh` so the `+esp` toolchain and `LIBCLANG_PATH` are set.
- Switch into the right firmware workspace (each firmware crate is its own workspace - see [philosophy.md#firmware-workspaces](philosophy.md#firmware-workspaces)).
- Apply the right `--features motor-rs485` / `motor-stepdir` / `motor-sim` gates.
- Pin `cargo +esp` for ESP targets and `cargo +stable` for WASM.

Raw `cargo build` will silently use the host toolchain and the wrong features, then either fail confusingly or "succeed" while having compiled nothing useful. The minimum bar before saying a change builds:

- Touched core / pattern engine / board / driver code: `just build-all` (firmware + WASM, parallel).
- Touched a single firmware target: `just build-<target>` for that target.
- Touched a WASM binding: `just build-wasm`.
- Touched a frontend app: `just web-tools` or `just docs` and verify it serves.

If a recipe is missing for what you're doing, prefer adding one to the justfile over teaching contributors a new manual incantation.

## Tooling check

```sh
just doctor
```

Runs [scripts/doctor.sh](../scripts/doctor.sh) (or `.ps1` on Windows). Confirms `cargo`, `+esp` toolchain, `~/export-esp.sh`, `wasm32-unknown-unknown`, `wasm-bindgen`, `wasm-opt`, `espflash`, `pnpm`, `node`. Run this before assuming the environment is fine.

## Building firmware

Each board has a build and flash recipe. All are released-mode (the dev profile is too slow for real hardware).

```sh
just build-ossm-alt           # ESP32-S3, RS485, OSSM Alt Edition
just build-ossm-reference     # ESP32, step/dir, original OSSM PCB
just build-waveshare          # ESP32-S3, RS485, Waveshare board
just build-seeed-xiao         # ESP32-S3, RS485, Seeed XIAO

just flash-ossm-alt           # build + flash + run with espflash
# (and matching `flash-*` recipes for the others)
```

### Swapping in the simulated motor

Every firmware build accepts `motor=sim` to overlay [drivers/sim-motor](../drivers/sim-motor) instead of the real motor. Useful for bench-testing on hardware without a stepper attached.

```sh
just build-ossm-alt motor=sim
just flash-ossm-alt motor=sim
```

The board still expects pin config (UART pins for RS485 etc.) so the call site doesn't change between real and sim. The sim layer drops those fields inside `build()`.

`build-ossm-reference` defaults to `motor=stepdir`. The others default to `motor=rs485`.

### Build everything

```sh
just build-all
```

Runs all firmware builds plus both WASM bindings in parallel.

## ESP toolchain

The `+esp` toolchain comes from [espup](https://github.com/esp-rs/espup) - it provides the xtensa-targeting Rust fork that ESP32/ESP32-S3 needs. The `[justfile]` sources `~/export-esp.sh` (or the Windows equivalent) before every recipe so PATH and LIBCLANG are right.

If a recipe fails with linker errors mentioning `xtensa`, the toolchain isn't sourced - run `just doctor` and check the `+esp` line.

## rust-analyzer with multiple targets

This is the trap. The repo targets:
- ESP32 (`xtensa-esp32-none-elf`, `+esp` toolchain) for `firmware/esp32`
- ESP32-S3 (`xtensa-esp32s3-none-elf`, `+esp` toolchain) for `firmware/esp32s3`
- `wasm32-unknown-unknown` (stable toolchain) for `bindings/*`
- The host (stable toolchain) for code that's portable

rust-analyzer can only analyze one target at a time. Without setup it tries to analyze everything as the host and produces false errors for embedded code.

```sh
just focus ossm-alt
just focus ossm-reference
just focus waveshare
just focus seeed-xiao
```

This script ([scripts/focus.sh](../scripts/focus.sh) / `.ps1`) symlinks (Unix) or copies (Windows) target-specific config TOMLs to the workspace root. After running it, **restart rust-analyzer or reload the editor**.

You only need to re-run when switching firmware targets. On Windows the copy approach means edits to the root configs don't sync back - keep that in mind.

## WASM bindings

```sh
just build-wasm-simulator     # bindings/web-simulator
just build-wasm-recorder      # bindings/trajectory-recorder
just build-wasm               # both
```

Each builds with `cargo +stable`, runs `wasm-bindgen --target web`, then `wasm-opt -O`, then writes a tiny `package.json`. The output goes in `bindings/<name>/pkg/` and is consumed by `apps/web-tools` via a `link:` dep.

## Apps

```sh
just web-tools                # builds wasm, then `pnpm dev --host`
just docs                     # `pnpm dev` for the Nextra docs site
```

`web-tools` rebuilds the WASM on demand. If the simulator misbehaves after a Rust change, kill `web-tools` and rerun it - Vite caches the linked package.

`docs` is a Next.js + Nextra app. MDX content is in [docs/](../docs/) (note: not `apps/docs/content/` - the docs/ at the root is the source of truth).

## CI

Workflows in [.github/workflows](../.github/workflows):
- `ci.yml` - `cargo check`, `cargo clippy`, formatting, on push and PR.
- `build-firmware.yml` - builds all firmware artefacts and uploads them to R2.
- `build-webtools.yml`, `build-docs.yml` - Cloudflare Pages preview deploys.
- `release.yml` - tagged releases.
- `upload-firmware.yml` - posts a PR comment with flash links for each firmware change.

## Common loops

**Iterating on a pattern:**
1. Edit [crates/pattern-engine/src/patterns/your_pattern.rs](../crates/pattern-engine/src/patterns/).
2. Add it to [crates/pattern-engine/src/patterns/mod.rs](../crates/pattern-engine/src/patterns/mod.rs) and the `define_patterns!` macro in [crates/pattern-engine/src/lib.rs](../crates/pattern-engine/src/lib.rs).
3. `just web-tools` and try it in the browser. The simulator runs the same pattern code - no flash needed.
4. Once it feels right, `just flash-ossm-alt` to try on real hardware.

**Iterating on the controller or a board:**
1. Edit [ossm/](../ossm/) or [boards/](../boards/).
2. The simulator (`just web-tools`) exercises the same crates - use it as your fast feedback loop.
3. Cross-build for ESP with `just focus ossm-alt && just build-ossm-alt` to confirm `no_std` still holds.

**Adding a new motor:**
1. New crate in [drivers/](../drivers/) implementing `Motor` (and optionally `Rs485Motor` or `StepDir` and `SelfHoming`).
2. New crate in [boards/](../boards/) (or extend an existing one) wiring it up.
3. New `motor-*` feature in [ossm-esp/Cargo.toml](../ossm-esp/Cargo.toml).
4. Wire it into [ossm-esp/src/motor/](../ossm-esp/src/motor) and the firmware crate's bin file.

**Adding a new board:**
1. New `boards/<name>/` crate implementing `Board`.
2. New bin in `firmware/esp32s3/src/bin/<name>.rs` (or `firmware/esp32/src/bin/`) with the right pin config.
3. New `build-<name>` and `flash-<name>` recipes in the [justfile](../justfile).
4. Add it to `build-all`.

## Devcontainer

[.devcontainer/devcontainer.json](../.devcontainer/devcontainer.json) brings up a Debian Trixie image with Rust pre-installed. To flash from inside the container, add `runArgs` exposing the UART device:

```json
"runArgs": ["--device=/dev/ttyUSB0"]
```

If the device disconnects while the container is running, the container loses access. Restart the container to re-acquire it.
