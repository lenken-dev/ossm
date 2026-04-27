# Conventions

Code style and naming. Where this conflicts with [philosophy.md](philosophy.md), the philosophy wins.

## Language and naming

- The project is a sex machine. Patterns are about strokes, depth, sensation. **Use direct names.** Don't euphemise: `stroke`, `depth`, `velocity`, `sensation`, `teasing_pounding` are correct identifiers. Don't replace them with neutered alternatives.
- Variables describe physical reality. `position_mm`, `velocity_mm_s`, `max_jerk_mm_s3`, `crawl_mm_per_poll`. Units in the name when ambiguous.
- Fractions are `f64` in `0.0..=1.0` unless the type makes the range obvious. Use `clamp(0.0, 1.0)` at the boundary.
- Public traits use bare verbs: `enable`, `disable`, `home`, `set_position`, `set_torque`. Match this when extending them.

## Punctuation

- **ASCII by default.** Stick to characters in the 0x20-0x7E range for code, comments, docs, and commit messages. The biggest reason is firmware logging over UART: log lines flow through `esp-println` to a serial monitor, and Windows terminals reading that stream often default to a code page that doesn't match the source, so non-ASCII bytes come out as garbled characters or `?`. The same class of issue shows up elsewhere too - editors auto-converting on save, terminals rendering wrong, copy/paste from a PR description into a shell - so the safe default is to keep the whole repo ASCII.
- **No em dashes (`—`) or en dashes (`–`).** These are the most common offenders. Use a regular hyphen `-`, or rephrase the sentence so the dash isn't needed.
- **No "smart" quotes (`"`, `"`, `'`, `'`), ellipses (`…`), or other typographic substitutes.** Use plain `"`, `'`, and `...`. Editors and AI tools will sometimes auto-substitute these silently - watch for them in diffs.
- The rule is repo-wide: source files, MDX docs, READMEs, anything text. The only exception is rendered docs content where a specific glyph is the subject of the sentence (e.g. demonstrating Unicode handling) - and even then, only inside a code block or fenced quote.

## Spelling

- **American English** (`color`, `behavior`, `signaling`, `centralize`, `customize`, `millimeter`, `flavor`, `modeled`, `canceled`). Applies to docs, comments, commit messages, and any prose.
- Code identifiers are exempt - if an existing Rust type is `Cancelled` (double-l, British), keep the identifier as-is. The rule is about prose, not API renames.
- Abbreviations stay as written: `mm`, `mm/s`, `mm/s^2`. SI units don't get Americanized.

## Comments

Default to **no comment**. The code's job is to be readable.

**Remove** comments that:
- Restate what the code says (`// transition to Idle` next to `state = Idle;`).
- Mirror function names or types (`/// Set the position` on `fn set_position`).
- Add section dividers (`// --- helpers ---`).

**Keep** comments that:
- Explain *why*, especially hardware quirks and non-obvious side effects (`// Switch to velocity control and target zero velocity. Ruckig handles the jerk-limited deceleration trajectory.`).
- Document units or valid ranges that the type can't express (`/// Torque limit as a fraction (0.0-1.0). \`None\` uses the motor default.`).
- Note intentionally empty match arms or `try_send` discards (`// Idempotent: already in target state, nothing to do.`).
- Explain memory or stack constraints (`// 16KB stack is needed for ruckig's trajectory calculator (heavy float math).`).

**Always keep** lint `reason` attributes - they configure clippy, not free-form comments:

```rust
#![deny(
    clippy::mem_forget,
    reason = "mem::forget is generally not safe with esp_hal types..."
)]
```

## Async

- All hardware traits use `async fn` (with `#[allow(async_fn_in_trait)]`). Don't wrap in a custom `Future`.
- Use `?` to propagate `Cancelled` in patterns. Never `let _ = ... .await`.
- `try_send` / `try_receive` for channels on the motion path so the controller doesn't block. Reserve `.send().await` for command-issue points where the caller can wait.
- Watch out for split borrows in the runner. The pinned future holds one field; access the rest through separate refs. There's a comment in [crates/pattern-engine/src/engine.rs](../crates/pattern-engine/src/engine.rs) explaining this.

## Errors

- `Result<T, Self::Error>` everywhere on hardware traits. `Self::Error: Debug`.
- The motion controller logs errors with `log::error!` and transitions to a safe state via `enter_fault()`. Don't `unwrap()` on the motion path.
- Best-effort disable: `if let Err(e) = self.board.disable().await { log::error!(...) }` then transition anyway. The disabled state is more important than the error.
- Patterns return `Result<(), Cancelled>`. Do not invent new error types for patterns.

## Static lifetimes

Embedded code uses `static` for shared state. The pattern is:

```rust
static OSSM: Ossm = Ossm::new();
static PATTERNS: PatternEngine = PatternEngine::new(&OSSM);
```

For things that aren't `const`-constructible:

```rust
use static_cell::StaticCell;
static EXECUTOR: StaticCell<InterruptExecutor<2>> = StaticCell::new();
let executor = EXECUTOR.init(InterruptExecutor::new(...));
```

There's a `mk_static!` macro in each firmware crate that wraps this pattern.

## no_std

- `ossm/`, `ossm-esp/`, `boards/*`, `drivers/*`, `crates/pattern-engine`, `crates/ble-remote`, `crates/ossm-m5-remote` - all `#![no_std]`.
- Use `alloc` only when needed and only with `extern crate alloc;` at the crate root.
- No `std::` imports. `core::` and `alloc::` only.
- Use `heapless::String` / `heapless::Vec` for fixed-capacity collections.

## HAL boundaries

- `ossm/`, `boards/*`, `drivers/*`, `crates/pattern-engine`: HAL-agnostic. Take `embedded-hal` / `embedded-hal-async` traits, never a concrete HAL crate. Don't add `esp-hal`, `esp-radio`, `esp-rtos`, `embassy-rp`, etc. to these.
- `ossm-esp/` and `firmware/esp32{,s3}/`: ESP-specific. Free to import `esp-hal` and friends.
- `crates/ble-remote`, `crates/ossm-m5-remote`: HAL-agnostic wire formats, ESP-specific radio driver today. Keep the parsing/format layer free of HAL specifics so a future port can reuse it.
- A new chip family means a new sibling glue crate (e.g. `ossm-rp/`) and a new firmware workspace, not new HAL imports in the layers above.

## Logging

- `log` crate, `log::info!` / `log::warn!` / `log::error!`.
- `info!` for state transitions (homing, pattern start/stop). `warn!` for ignored commands. `error!` for faults.
- Released firmware caps at info level (`features = ["release_max_level_info"]`).

## Formatting

- `cargo fmt` runs in CI. Default rustfmt config.
- TypeScript: project uses Prettier defaults via the editor; no committed config to fight.

## Commits and PRs

- Conventional-ish prefixes (`feat:`, `fix:`, `refactor:`, `docs:`) - look at recent commits for the in-flight style.
- One concept per PR. Refactors and feature work go in separate PRs unless they're truly inseparable.
- Don't bundle "drive-by cleanups" into a feature PR. Open them separately so reviewers can decide each on its own merits.
- The CI firmware build will post flash links on the PR (see [.github/workflows/upload-firmware.yml](../.github/workflows/upload-firmware.yml)). Use them to test on hardware before merging anything that touches motion.

## What not to add

- New top-level files at the repo root. Put things under an existing crate or app, or argue for a new directory in `philosophy.md` first.
- Build helpers in the root `Cargo.toml`. The root is `[workspace]` only.
- Cargo features that turn on platform code in `ossm/`. Platform stuff lives in `ossm-esp/` or further down.
- Fallback / "just in case" code paths. If a state is unreachable, don't write a branch for it. The controller's `_ => respond(InvalidTransition)` is the model: one explicit catch-all, not three speculative ones.
