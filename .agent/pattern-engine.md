# crates/pattern-engine

The pattern engine. Defines the `Pattern` trait, runs patterns as async tasks, exposes shared `PatternInput` (depth, stroke, velocity, sensation), and ships seven built-in patterns. `no_std`. Depends only on `ossm`, `embassy-sync`, `embassy-futures`, `embedded-hal-async`, `log`.

This is where contributors will spend the most time. The trait is intentionally tiny so adding a pattern doesn't require understanding the rest of the system.

## Public surface

[crates/pattern-engine/src/lib.rs](../crates/pattern-engine/src/lib.rs):

- `Pattern` (trait) - one method plus two consts: `run(&mut self, ctx: &mut PatternCtx<...>) -> Result<(), Cancelled>`, plus `NAME` and `DESCRIPTION`.
- `PatternCtx` - given to a pattern. Lets it issue motion commands and read live input.
- `PatternEngine` - the engine itself. `static`-friendly. Owns a command channel, the shared input, and an engine-state pubsub.
- `PatternEngineRunner` - the async task that consumes commands and drives patterns.
- `EngineState` - observable state (Idle, Homing, Ready, Playing(idx), Paused(idx)).
- `PatternInput` / `SharedPatternInput` - the shared knobs (`depth`, `stroke`, `velocity`, `sensation`).
- `AnyPattern` - the macro-generated enum that lets the engine hold a heterogeneous list of pattern types.
- `commands::*` - the message types that remotes send (BLE, ESP-NOW, web). Two flavors: `PlaybackCommand` (play/pause/resume/home/stop) and `InputCommand` (knob updates).

## How a pattern works

A pattern is an async loop. The simplest one:

```rust
impl Pattern for Simple {
    const NAME: &'static str = "Simple Stroke";
    const DESCRIPTION: &'static str = "Simple in and out. Sensation does nothing.";

    async fn run(&mut self, ctx: &mut PatternCtx<impl DelayNs>) -> Result<(), Cancelled> {
        loop {
            ctx.motion().position(1.0).send().await?;
            ctx.motion().position(0.0).send().await?;
        }
    }
}
```

`ctx.motion()` returns a builder. `.position(f)` is required (compile-time enforced via the typestate `NoPosition`/`HasPosition`). `.speed(factor)` and `.torque(factor)` are optional. `.send().await?` issues the move and waits for it to complete.

Inside `send().await`:
- Computes the `MotionCommand` from current `PatternInput` and the requested fraction.
- Sends it to the controller.
- Awaits motion completion *while watching* for `PatternInput` changes. If the user moves a slider mid-stroke, the in-flight motion is updated (`update_motion`) without resetting completion.
- Returns `Err(Cancelled)` if the controller canceled the move (disable, home, pause).

The `?` propagates cancellation up to the runner, which cleans up.

## Adding a pattern

1. New file in [patterns/](../crates/pattern-engine/src/patterns/) implementing `Pattern`.
2. Re-export from [patterns/mod.rs](../crates/pattern-engine/src/patterns/mod.rs).
3. Add a variant to `define_patterns!` in [lib.rs](../crates/pattern-engine/src/lib.rs). The macro generates `AnyPattern`, the dispatch, `BUILTIN_PATTERNS`, and `all_builtin()`.
4. Test in the simulator: `just web-tools`.

The pattern should:
- Use `ctx.scale_sensation(min, max)` to map sensation into a useful range.
- Re-read input across `await` points if it depends on more than the current call's slider value.
- Propagate `?` on every `.send().await`.
- Loop forever. The runner exits the pattern when a state command cancels the in-flight move.

## Engine state machine

`PatternEngineRunner::run` (in [engine.rs](../crates/pattern-engine/src/engine.rs)) is the loop:

```
Idle -- Play(idx) -----> Homing(Some(idx)) -- home ok --> Playing(idx)
Idle -- Home --------> Homing(None)       -- home ok --> Ready
Ready -- Play(idx) ----------------------------------> Playing(idx)  (no re-home)
Playing(idx) -- Pause -> sends ossm.pause(), publishes Paused(idx)
Paused(idx) -- Resume -> sends ossm.resume(), publishes Playing(idx)
Playing(_) -- Play(new) ----------------------------> Playing(new)   (swap pattern)
* -- Stop ----------------------------------> Idle (after disable)
```

Pause / Resume are handled inside the `Playing` inner loop because they need the in-flight pattern future to keep its borrow on the patterns array. The comment in `engine.rs` ("Split borrows: ...") explains this and the resulting direct calls to `engine.publish_state()` from the inner loop.

## `PatternInput`

```rust
pub struct PatternInput {
    pub depth: f64,      // 0.0..=1.0 of the machine range. The "deepest" a stroke goes.
    pub stroke: f64,     // 0.0..=1.0. Stroke length as a fraction of depth.
    pub velocity: f64,   // 0.0..=1.0 of MotionLimits.max_velocity_mm_s.
    pub sensation: f64,  // -1.0..=1.0. Pattern-specific.
}
```

Stored in a `Watch` channel ([input.rs](../crates/pattern-engine/src/input.rs)) so the pattern can `.changed().await` to be notified of slider updates and remotes can `.send_modify()` from any context.

A pattern issues `position(f)` where `f` is the fraction of the *stroke envelope*. Inside `compute_command`:

```rust
let stroke = depth * stroke;             // actual stroke length
let shallow = depth - stroke;            // shallowest point
let position = shallow + fraction * stroke;
```

So `position(0.0)` is the shallowest end of the user's chosen stroke, `position(1.0)` is the deepest. The pattern doesn't have to know about depth or stroke explicitly.

## When to change this crate

- Adding a new pattern: yes, add freely.
- Extending the `Pattern` trait: only if a new capability is needed by every pattern. Otherwise, add it on `PatternCtx`.
- New `PatternInput` field: yes if it's a knob users will see. Update `commands::InputCommand` to match. Plumb through the BLE/ESP-NOW/web remotes.
- New engine state: probably not. The current state set covers the lifecycle.
