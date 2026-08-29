# 13 — The pattern engine

> Prerequisites: [10-core-ossm.md](10-core-ossm.md),
> [rust/04-async-and-embassy.md](rust/04-async-and-embassy.md)

`crates/pattern-engine` is the layer that decides *what* motion to perform.
A pattern is an infinite async loop of motion requests; the engine runs one at
a time and handles play/pause/stop around it.

## A pattern is a coroutine

```rust
pub struct Simple;

impl Pattern for Simple {
    const NAME: &'static str = "Simple Stroke";
    const DESCRIPTION: &'static str = "Simple in and out. Sensation does nothing.";

    async fn run(&mut self, ctx: &mut PatternCtx<'_, impl DelayNs>) -> Result<(), ossm::Cancelled> {
        loop {
            ctx.motion().position(1.0).send().await?;
            ctx.motion().position(0.0).send().await?;
        }
    }
}
```

That is the complete implementation of the simplest pattern. Three things are
happening that are worth unpacking:

**`loop { }` with no exit.** The function never returns normally. It exits
only via the `?` operator, when a move is cancelled.

**`.await` suspends, it does not block.** Each `send().await` hands control
back to the executor until the controller reports the move finished. On an
MCU with no threads, this is how one CPU runs a pattern, a BLE stack, and a
motion loop concurrently. See
[rust/04-async-and-embassy.md](rust/04-async-and-embassy.md).

**`?` is the cancellation path.** `send()` returns
`Result<(), Cancelled>`. `?` means "if this is `Err`, return it from the
enclosing function immediately". So when a `disable` command cancels the
in-flight move, the pattern unwinds out of its infinite loop with no
`if (stopRequested) return;` scattered through it. See
[rust/03-error-handling.md](rust/03-error-handling.md).

A pattern with state is just as direct — `StopNGo` keeps counters as ordinary
local variables across `.await` points:

```rust
async fn run(&mut self, ctx: &mut PatternCtx<'_, impl DelayNs>) -> Result<(), ossm::Cancelled> {
    let mut num_strokes: usize = 1;
    let mut counting_up = true;

    loop {
        for _ in 0..num_strokes {
            ctx.motion().position(1.0).send().await?;
            ctx.motion().position(0.0).send().await?;
        }
        let delay = ctx.scale_sensation(MIN_DELAY_MS, MAX_DELAY_MS) as u64;
        ctx.delay_ms(delay).await;
        // ... adjust num_strokes ...
    }
}
```

In C++ you would write this as an explicit state machine with a `step()`
method and member variables for `num_strokes`, `counting_up`, and "where in
the sequence am I". The async version keeps that state on the future's own
stack frame, and the compiler generates the state machine for you.

## The four live inputs

```rust
pub struct PatternInput {
    /// Maximum depth as a fraction of the machine range (0.0–1.0).
    pub depth: f64,
    /// Stroke as a fraction of depth (0.0–1.0).
    /// Shallowest point = `depth * (1.0 - stroke)`.
    pub stroke: f64,
    /// Velocity as a fraction of max velocity (0.0–1.0).
    pub velocity: f64,
    /// Sensation value (-1.0 to 1.0). Meaning is pattern-specific.
    pub sensation: f64,
}

pub type SharedPatternInput = Watch<CriticalSectionRawMutex, PatternInput, 1>;
```

`depth` and `stroke` define a *window* within the machine range; a pattern's
`position(fraction)` is a fraction of that window, not of the machine:

```
0 mm                                                          machine range 1.0
 ├──────────────────────────────────────────────────────────────────────┤
                    ├────────── stroke window ──────────┤
                 shallow                              depth
              (= depth·(1-stroke))
                position(0.0)                      position(1.0)
```

The translation happens in one function:

```rust
fn compute_command(input: &PatternInput, fraction: f64, speed_factor: f64,
                   jerk_factor: f64, torque: Option<f64>) -> MotionCommand {
    let stroke   = input.depth * input.stroke.clamp(0.0, 1.0);
    let shallow  = input.depth - stroke;
    let position = shallow + fraction * stroke;
    let speed    = input.velocity * speed_factor.clamp(0.0, 1.0);
    MotionCommand { position, speed, jerk: jerk_factor.clamp(0.0, 1.0), torque }
}
```

`Watch` is an Embassy primitive: a single shared slot where writes overwrite
and readers can either poll (`try_get()`) or await a change (`changed()`).
Exactly right for a slider — a reader that missed three intermediate values
has lost nothing.

`sensation` is deliberately undefined at this layer. Each pattern maps it to
whatever makes sense: `StopNGo` maps it to a delay, others to a stroke-length
bias. `ctx.scale_sensation(out_min, out_max)` does the linear remap.

## `PatternCtx` and the typestate builder

`PatternCtx` is what a pattern is handed: the motion sender, the input watch,
a watch receiver, and a delay source.

```rust
pub struct PatternCtx<'m, D: DelayNs> {
    motion: &'m MotionSender,
    input: &'m SharedPatternInput,
    input_receiver: Receiver<'m, CriticalSectionRawMutex, PatternInput, 1>,
    delay: D,
}
```

Note it holds `&MotionSender` — a *borrow*. The pattern can command motion for
exactly as long as the borrow lives, and cannot stash it anywhere. That is the
capability model from [10-core-ossm.md](10-core-ossm.md) doing its job.

`ctx.motion()` returns a builder with a small but clever trick:

```rust
pub struct NoPosition;
pub struct HasPosition(f64);

pub struct MotionBuilder<'a, 'm, D: DelayNs, P> { /* ..., position: P, ... */ }

impl<'a, 'm, D: DelayNs> MotionBuilder<'a, 'm, D, NoPosition> {
    pub fn position(self, fraction: f64) -> MotionBuilder<'a, 'm, D, HasPosition> { /* ... */ }
}

impl<'a, 'm, D: DelayNs> MotionBuilder<'a, 'm, D, HasPosition> {
    pub async fn send(self) -> Result<(), Cancelled> { /* ... */ }
}
```

`send()` exists **only** on `MotionBuilder<_, _, _, HasPosition>`. Writing
`ctx.motion().send()` is not a runtime error or an assert — it is a compile
error, because that method does not exist on that type. The `.speed()`,
`.jerk()`, `.torque()` modifiers are implemented for both states so they can
appear in any order. This is the "typestate" pattern; C++ can approximate it
with tag types and SFINAE, but here it is just two empty structs.

## Live input during a move

`send()` is not a simple await. It races three futures:

```rust
loop {
    match select::select3(
        move_done.as_mut(),                  // the controller finished the move
        self.ctx.input_receiver.changed(),   // the user moved a slider
        throttle.next(),                     // a 250 ms ticker
    ).await
    {
        Either3::First(result)   => return result,
        Either3::Second(new_input) => { pending = Some(new_input); }
        Either3::Third(())       => {
            if let Some(input) = pending.take() {
                let cmd = compute_command(&input, fraction, speed_factor, jerk_factor, torque);
                self.ctx.motion.update_motion(cmd);   // retarget, don't restart
            }
        }
    }
}
```

`select3` polls all three and returns whichever completes first, as an
`Either3` enum you must match on — the compiler will not let you forget a case.

The 250 ms throttle is a real constraint, documented in the source: every
forwarded update costs a Ruckig replan (5–15 ms), and an unthrottled BLE input
flood would starve the 100 Hz motion loop. So input changes are *collected*
and applied at most 4 times a second. Note it calls `update_motion`, not
`begin_motion` — the completion signal is not reset, so the move keeps its
identity while its target slides.

## The engine and its state machine

`PatternEngine` splits exactly like `Ossm`:

```rust
pub fn split(&'static mut self) -> (PatternRunner, PatternObserver, PatternSender)
```

- `PatternSender` — `play(idx)`, `pause`, `resume`, `stop`, `home`, plus the
  four input setters. This is what a BLE remote or the browser UI holds.
- `PatternObserver` — read `EngineState` and `PatternInput`, subscribe.
- `PatternRunner` — the driver. `run()` never returns (`-> !`).

```
                Play(i)                       home completes
     Idle ──────────────────▶ Homing(Some(i)) ────────────────▶ Playing(i)
      ▲                            │                            │  ▲
      │ Stop                       │ Stop/Pause                 │  │ Resume
      └────────────────────────────┴────────────────────────────┘  │
                                                       Paused(i) ──┘
```

Two levels of "pause" exist and they are different things: `EngineCommand::Pause`
tells the *engine* to stop issuing new moves and calls `motion.pause()`, which
tells the *controller* to decelerate to a stop. The engine state is
`Paused(idx)`, the motion phase is `Paused`.

The runner's `Playing` arm is a `select` between the pattern's own future and
the command channel:

```rust
let mut ctx = PatternCtx::new(motion, input, delay.clone());
let pattern_fut = core::pin::pin!(patterns[idx].run(&mut ctx));

loop {
    match select::select(pattern_fut.as_mut(), engine.commands.receive()).await {
        Either::First(_result) => { /* pattern exited (cancelled) → Idle */ }
        Either::Second(cmd) => match cmd {
            EngineCommand::Pause  => { motion.pause().await;  /* ... */ }
            EngineCommand::Resume => { motion.resume().await; /* ... */ }
            EngineCommand::Play(new_idx) if new_idx < N => { /* switch pattern */ }
            EngineCommand::Stop   => { motion.disable().await; /* ... */ }
            _ => {}
        },
    }
}
```

`EngineCommand::Play(new_idx) if new_idx < N` is a **match guard** — a `match`
arm with an extra boolean condition. `N` is the array length, a const generic
parameter, so switching to a non-existent pattern is impossible.

Engine state is also mirrored into an `AtomicU16` (`EngineState::encode` packs
the tag into the high byte and the pattern index into the low byte). That is
what the WASM `get_engine_state()` reads — an atomic load needs no `async` and
no lock, so JavaScript can poll it every animation frame for free.

## `AnyPattern` and the macro

Patterns are different types, and `no_std` async trait objects are awkward. So
the crate generates an enum instead:

```rust
define_patterns! {
    Simple(Simple),
    Deeper(Deeper),
    HalfHalf(HalfHalf),
    // ... 15 in total
    None(NonePattern),
}
```

The `macro_rules!` macro expands that list into the `AnyPattern` enum, a
`Pattern` impl that dispatches with a `match`, `From` impls, a
`BUILTIN_PATTERNS: [PatternMeta; N]` metadata array, and
`all_builtin() -> [AnyPattern; N]`. See
[rust/07-macros.md](rust/07-macros.md) for how that works.

The result is static dispatch, a compile-time-known count, and a single place
to register a new pattern. Adding one is: write a struct implementing
`Pattern`, re-export it from `patterns/mod.rs`, add a line to
`define_patterns!`. It then appears automatically in the firmware, the BLE
pattern list, the browser dropdown, and the graph page.

(There is also `docs/so-you-want-to-add-a-pattern.md` in this repo with the
step-by-step version.)
