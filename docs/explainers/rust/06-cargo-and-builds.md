# Rust: crates, workspaces, features, targets, `build.rs`

The build system. Cargo is package manager, build system, and test runner in
one — closer to `npm` than to CMake, but producing native binaries.

## Crates and packages

A **crate** is the unit of compilation: one library or one binary. A
**package** is a directory with a `Cargo.toml`; it may contain one library and
any number of binaries.

```toml
[package]
name = "esp32s3"
edition = "2024"

[[bin]]
name = "ossm-alt"
path = "src/bin/ossm-alt.rs"

[[bin]]
name = "waveshare"
path = "src/bin/waveshare.rs"
```

`firmware/esp32s3` is one package with a library (`src/lib.rs`, holding the
shared boot sequence) and three binaries (one per board variant). The
binaries `use esp32s3::...` to reach the library.

The **edition** (2015/2018/2021/2024) is an opt-in language revision. Crates of
different editions interoperate freely; this repo is uniformly 2024.

There is no header/source split and no include order. Module structure comes
from the filesystem: `mod motion;` in `lib.rs` pulls in `src/motion.rs`, and
`pub use` re-exports selected items to form the crate's public API:

```rust
// ossm/src/lib.rs
mod motion;
pub use motion::MotionController;
```

Visibility: private by default, `pub` public, `pub(crate)` visible within the
crate. The `Ossm` struct's channel fields are `pub(crate)` — the handles can
reach them, external code cannot.

## Workspaces

A workspace shares one lockfile, one `target/` directory, and one dependency
resolution across several packages.

```toml
# /Cargo.toml
[workspace]
resolver = "3"
members = ["ossm", "drivers/*", "boards/*", "crates/*"]
```

Notice what is *not* a member: `firmware/*`, `ossm-esp/`, and `bindings/*`.
Each of those declares its own `[workspace]`, making it a separate root.

That is deliberate. A workspace builds all members for one target with one
toolchain. The root workspace is host-native (so `cargo test` and
`cargo run -p ossm-flash` work); `firmware/esp32s3` is Xtensa with the `esp`
toolchain; `bindings/web-simulator` is `wasm32-unknown-unknown` with stable.
Three targets, three workspaces.

Each isolated workspace pins its own toolchain and default target:

```toml
# bindings/web-simulator/rust-toolchain.toml
[toolchain]
channel = "stable"
targets = ["wasm32-unknown-unknown"]
```

```toml
# bindings/web-simulator/.cargo/config.toml
[build]
target = "wasm32-unknown-unknown"
```

With those two files, a bare `cargo build` in that directory does the right
thing. `rustup` reads `rust-toolchain.toml` and will install the toolchain if
missing.

## Target triples

`<arch>-<vendor>-<os>-<abi>`:

| Triple | Where |
| --- | --- |
| `xtensa-esp32s3-none-elf` | OSSM-ALT, waveshare, seeed-xiao |
| `xtensa-esp32-none-elf` | ossm-reference |
| `wasm32-unknown-unknown` | both WASM bindings |
| host (e.g. `x86_64-unknown-linux-gnu`) | `ossm-flash`, tests |

`none` in the OS field means bare metal — which is what makes `#![no_std]`
mandatory for those targets.

Xtensa is not supported by upstream LLVM, so Espressif ships a patched
compiler installed by `espup` and selected with `cargo +esp build`. (`+name`
picks a toolchain for one invocation.)

## Features

Features are named, additive compile-time options.

```toml
# ossm-esp/Cargo.toml
[features]
esp32   = ["esp-hal/esp32"]
esp32s3 = ["esp-hal/esp32s3"]

motor-rs485   = ["dep:m57aim-motor", "dep:rs485-board"]
motor-stepdir = ["dep:m57aim-motor", "dep:stepdir-board", "dep:embedded-hal-async", "dep:nb"]
motor-sim     = ["dep:sim-motor", "dep:sim-board"]

[dependencies]
m57aim-motor = { path = "../drivers/m57aim", optional = true }
```

A feature can enable optional dependencies (`dep:foo`) and features of
dependencies (`esp-hal/esp32s3`). `optional = true` means the crate is not
compiled unless something asks for it.

In code, `#[cfg(feature = "...")]` includes or excludes items:

```rust
#[cfg(feature = "motor-rs485")]
pub mod rs485;

#[cfg(all(feature = "motor-rs485", not(feature = "motor-sim")))]
pub use ossm_esp::motor::rs485::build;
```

This looks like `#ifdef` but differs in three ways that matter: the conditions
are declared in `Cargo.toml` rather than passed ad hoc; excluded code is
*parsed* (so it must at least be syntactically valid); and there is no
preprocessor, so no macro-expansion surprises.

`cfg` also tests target properties: `#[cfg(target_arch = "wasm32")]`,
`#[cfg(not(feature = "std"))]`.

### Features are additive — and the consequence

If two crates in one build both depend on `ossm-esp`, the enabled feature set
is the *union*. Features must therefore never be mutually exclusive; enabling
more must only ever add.

This project uses that property deliberately:

```toml
# firmware/esp32s3/Cargo.toml
# motor-sim pulls in motor-rs485 so the `Config` types (pin names etc.) stay
# visible - the sim layer drops the fields inside `build` so bin-file call
# sites don't change between real and sim builds.
motor-sim = ["ossm-esp/motor-sim", "motor-rs485"]
```

And it guards against a nonsensical configuration with a hard error:

```rust
#[cfg(not(feature = "motor-rs485"))]
compile_error!(
    "This crate currently requires the motor-rs485 feature. Add --features motor-sim to \
    overlay a simulated motor for bench testing."
);
```

`compile_error!` fails the build with your message — the way to make an invalid
feature combination impossible rather than merely broken.

## `default-features = false`

Most crates have a `default` feature set that usually includes `std`. For
`no_std` builds you turn it off and re-add what you need:

```toml
rsruckig = { version = "2.1.3", default-features = false, features = ["libm", "alloc"] }
rmodbus  = { version = "0.12.2", default-features = false, features = ["heapless"] }
```

`libm` supplies software floating-point functions (`powf`, `sqrt`) that would
otherwise come from the C library.

## Profiles

```toml
[profile.release]
incremental = false
lto = 'fat'
codegen-units = 1
opt-level = 's'      # optimise for size
debug = 2            # keep symbols for backtraces
overflow-checks = false
```

Firmware is size-constrained, so `opt-level = 's'` and full LTO. `debug = 2`
costs nothing on the device (debug info stays in the ELF, not the flashed
image) and makes `esp-backtrace` output readable.

Note `overflow-checks = false` in release: in debug builds, integer overflow
panics; in release it wraps. That is a deliberate, per-profile choice.

## `build.rs`

A build script compiles and runs on the *host* before the crate itself, and
communicates by printing directives to stdout.

```rust
// bindings/web-simulator/build.rs
fn main() {
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let commit = /* git rev-parse --short HEAD */;
    let release_id = std::env::var("OSSM_RELEASE_ID").unwrap_or_else(|_| "dev".into());
    let build_time = /* date -u */;
    let info = format!("{device}\0{commit}\0{release_id}\0{build_time}\0");
    fs::write(format!("{out_dir}/ossm_build_info.bin"), info.as_bytes()).unwrap();
}
```

The crate then pulls that generated file into the binary at compile time:

```rust
include_bytes!(concat!(env!("OUT_DIR"), "/ossm_build_info.bin"))
```

The firmware's build script also emits linker arguments:

```rust
fn main() {
    ossm_esp_build_support::emit_build_info();
    ossm_esp_build_support::linker_be_nice();
    println!("cargo:rustc-link-arg=-Tlinkall.x");
}
```

`-Tlinkall.x` is the ESP linker script that places sections in the right
memory regions. `cargo:` lines are the build-script protocol; others include
`cargo:rerun-if-changed=path` and `cargo:rustc-cfg=...`.

## The command layer

`justfile` recipes wrap everything (`just` is a task runner, like `make`
without the build graph):

```
just build ossm-alt              # cargo run -p ossm-flash -- ossm-alt --build-only
just flash ossm-alt              # + espflash flash --monitor
just flash seeed-xiao sim        # with --motor sim
just build-wasm                  # both wasm bindings
just web-tools                   # build-wasm, then the Vite dev server
just focus ossm-alt              # point rust-analyzer at that target
just doctor                      # check the toolchain
```

`ossm-flash` (`crates/ossm-flash`) is a small host binary holding the variant
table — which workspace, which bin, which target triple, which default motor
feature — so those facts live in typed Rust rather than in shell.

`just focus` matters day to day: rust-analyzer can only analyse one target at
a time, so it symlinks the chosen firmware's config into the workspace root.
Without it you get spurious errors on embedded or WASM code.
