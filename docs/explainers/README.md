# OSSM explainers

An onboarding tour of this codebase, written for a developer who knows C++
on embedded Linux but has not written Rust.

Read `00-overview.md` first. Everything else is reachable from there.

## OSSM topics

| File | What it covers |
| --- | --- |
| [00-overview.md](00-overview.md) | Top-down: where the code lives and how information flows from a slider to a motor |
| [10-core-ossm.md](10-core-ossm.md) | The `ossm` crate: the `Ossm` handle split, the command channels, the motion state machine |
| [11-trajectory-planning.md](11-trajectory-planning.md) | Ruckig, motion limits, the fraction↔millimetre boundary, the standalone `Planner` trait |
| [12-boards-and-motors.md](12-boards-and-motors.md) | The `Board` / `Motor` / transport traits and how a real driver is assembled from them |
| [13-pattern-engine.md](13-pattern-engine.md) | The `Pattern` trait, `PatternCtx`, live inputs, and the engine's own state machine |
| [20-wasm-simulator.md](20-wasm-simulator.md) | `bindings/web-simulator`: the whole firmware compiled into the browser |
| [21-trajectory-recorder.md](21-trajectory-recorder.md) | `bindings/trajectory-recorder`: the second, headless WASM binding that feeds the graphs |
| [22-web-tools-frontend.md](22-web-tools-frontend.md) | `apps/web-tools`: the React app and the JS↔Rust boundary |
| [30-ossm-alt.md](30-ossm-alt.md) | The OSSM-ALT variant end to end: pins, RS485, the 57AIM motor, boot, build |

## Rust concepts

These exist so the OSSM topics can link out instead of stopping to explain
the language. Each one is framed against its C++ equivalent.

| File | What it covers |
| --- | --- |
| [rust/01-ownership-and-borrowing.md](rust/01-ownership-and-borrowing.md) | Move semantics, `&`/`&mut`, lifetimes, `'static` |
| [rust/02-traits-and-generics.md](rust/02-traits-and-generics.md) | Traits vs. abstract classes, monomorphisation, associated types |
| [rust/03-error-handling.md](rust/03-error-handling.md) | `Option`, `Result`, `?`, `match`, and why there are no exceptions |
| [rust/04-async-and-embassy.md](rust/04-async-and-embassy.md) | `async`/`await`, futures, executors, Embassy channels and signals |
| [rust/05-no-std-and-statics.md](rust/05-no-std-and-statics.md) | `no_std`, `alloc`, `StaticCell`, interior mutability, `unsafe` |
| [rust/06-cargo-and-builds.md](rust/06-cargo-and-builds.md) | Crates, workspaces, features, `cfg`, target triples, `build.rs` |
| [rust/07-macros.md](rust/07-macros.md) | `macro_rules!`, derive macros, attribute macros |
| [rust/08-wasm-bindgen.md](rust/08-wasm-bindgen.md) | `cdylib`, `#[wasm_bindgen]`, how a Rust struct becomes a JS class |
