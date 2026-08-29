# 21 — The trajectory recorder (`bindings/trajectory-recorder`)

> Prerequisites: [20-wasm-simulator.md](20-wasm-simulator.md),
> [11-trajectory-planning.md](11-trajectory-planning.md)

## Why there are two WASM modules

The simulator ([20](20-wasm-simulator.md)) runs in real time: to see 20
seconds of a pattern you wait 20 seconds. The graph page needs the opposite —
plot 20 seconds of position, velocity and acceleration *instantly*, and replot
on every slider movement.

So the recorder is the same pattern code, run **as fast as the CPU allows,
with simulated time**. No controller, no board, no motor, no executor.

| | web-simulator | trajectory-recorder |
| --- | --- | --- |
| Time | real, 10 ms ticker | simulated, computed as fast as possible |
| Uses | `MotionController` + `Board` + `Motor` | `RuckigPlanner` only |
| Async | `spawn_local`, real executor | manual `poll()` in a `while` loop |
| Output | live position, polled per frame | three `Float32Array`s |
| Drives | the 3D scene | the charts |

Both are visible on the Simulator page at once: the 3D model moves in real
time from the simulator, and the chart under it is a pre-computed recording of
the same inputs.

## The exported object

```rust
#[wasm_bindgen]
pub struct TrajectoryRecorder {
    receiver: MotionReceiver,
    motion: MotionSender,
}
```

It keeps the `MotionReceiver` rather than turning it into a controller. That
is what the `sim` feature on the `ossm` crate is for:

```rust
#[cfg(feature = "sim")]
mod sim {
    impl MotionReceiver {
        pub fn try_recv_motion(&self) -> Option<MotionCommand> { /* ... */ }
        pub fn signal_motion_complete(&self) { /* ... */ }
        pub fn respond_state(&self, resp: StateResponse) { /* ... */ }
        pub fn try_recv_state(&self) -> Option<StateCommand> { /* ... */ }
    }
}
```

`#[cfg(feature = "sim")]` compiles that block only when the feature is
enabled — the `#ifdef` of Rust, but with the condition declared in
`Cargo.toml` and checked by the build system rather than by the preprocessor.
See [rust/06-cargo-and-builds.md](rust/06-cargo-and-builds.md).

The effect: the recorder *impersonates the motion controller*. It receives the
pattern's commands off the same channel a real controller would, answers them,
and signals completion — so the pattern code is completely unaware it is not
talking to hardware.

## Manually polling a future

This is the most unusual code in the repository, and it is worth understanding
because it shows what `async` actually is.

A Rust `async fn` returns a `Future`: a value with one method,
`poll(&mut self, cx: &mut Context) -> Poll<Output>`, returning either
`Poll::Pending` ("not done, wake me when there is progress") or
`Poll::Ready(value)`. An *executor* is just a loop that calls `poll` and
arranges to be woken. See [rust/04-async-and-embassy.md](rust/04-async-and-embassy.md).

The recorder writes that loop by hand:

```rust
let mut ctx = PatternCtx::new(self.motion, self.input, delay);
let future = pattern.run(&mut ctx);
let mut future = pin!(future);

let waker = Waker::noop();
let mut cx = Context::from_waker(&waker);

loop {
    let poll = future.as_mut().poll(&mut cx);
    if poll.is_ready() { break; }

    // Impersonate the controller: answer state commands.
    if let Some(cmd) = self.receiver.try_recv_state() {
        match cmd {
            StateCommand::Enable | StateCommand::Home =>
                self.receiver.respond_state(StateResponse::Completed),
            _ => {}
        }
        continue;
    }

    // A motion command: run the planner to completion, recording every tick.
    if let Some(cmd) = self.receiver.try_recv_motion() {
        self.drive_planner(planner, &cmd, &mut samples, max_samples);
        if samples.len() >= max_samples { break; }
        self.receiver.signal_motion_complete();
        continue;
    }

    // Neither: the pattern must have asked for a delay. Emit idle samples.
    let delay_ticks = delay_state.take_pending_ms(timestep_ms);
    if delay_ticks > 0 {
        let idle = Sample { position: planner.position(), velocity: 0.0, acceleration: 0.0 };
        let count = delay_ticks.min(max_samples - samples.len());
        samples.extend(iter::repeat(idle).take(count));
        if samples.len() >= max_samples { break; }
        continue;
    }
}
```

- **`Waker::noop()`** — a do-nothing waker. A normal executor uses the waker
  to be told when to re-poll; here the loop simply polls again immediately, so
  no wakeup mechanism is needed.
- **`pin!`** — a future may hold references into itself (a borrow held across
  an `.await`), so it must not move in memory once polled. `Pin` is the type
  that encodes that guarantee.
- **`continue` after each branch** — re-poll the pattern after every response,
  so the pattern advances one step per iteration.

Where a real system would have interrupts, timers and an executor, this is a
single-threaded `while` loop that is both the controller and the clock.

### Fake time

The delay source is a custom `DelayNs` that records the requested duration and
yields exactly once:

```rust
impl embedded_hal_async::delay::DelayNs for RecordingDelay<'_> {
    async fn delay_ns(&mut self, ns: u32) {
        self.state.accumulate(ns as u64);
        YieldOnce::new().await;   // return Pending once so the loop sees the request
    }
}

struct YieldOnce(bool);

impl Future for YieldOnce {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
        if self.0 { Poll::Ready(()) } else { self.0 = true; Poll::Pending }
    }
}
```

So a pattern's `ctx.delay_ms(3000).await` costs no wall-clock time at all —
the loop converts 3000 ms into 300 identical idle samples at the current
position and moves on. That is `YieldOnce`: a hand-written future, about as
small as a future can be, demonstrating the whole `Future` contract in eight
lines.

### The planner run

Each motion command is expanded into the full set of ticks it would take:

```rust
fn drive_planner<P: Planner>(&self, planner: &mut P, cmd: &MotionCommand,
                             samples: &mut Vec<Sample>, max_samples: usize) {
    planner.set_target(cmd.position, cmd.speed, cmd.jerk);
    loop {
        let out = planner.tick();
        samples.push(Sample { position: out.position, velocity: out.velocity,
                              acceleration: out.acceleration });
        if out.finished || samples.len() >= max_samples { break; }
    }
}
```

The planner is `RuckigPlanner`, configured in the 0–1 domain by dividing the
physical limits by the rail length:

```rust
const LIMITS: MotionLimits = MotionLimits::DEFAULT;
const RANGE_MM: f64 = LIMITS.max_position_mm - LIMITS.min_position_mm;
const TIMESTEP_MS: f64 = 10.0;   // matches firmware UPDATE_INTERVAL_SECS

let mut planner = RuckigPlanner::new(
    LIMITS.max_velocity_mm_s / RANGE_MM,
    LIMITS.max_acceleration_mm_s2 / RANGE_MM,
    LIMITS.max_jerk_mm_s3 / RANGE_MM,
    timestep_secs,
);
```

The 10 ms timestep is deliberately the same as the firmware's, with a comment
saying so — the graph shows what the hardware would actually do, at hardware
resolution.

Caveat: `RuckigPlanner` is a re-implementation of the controller's planning in
the 0–1 domain, not the controller itself. Its jerk mapping is similar but not
character-for-character identical to `MotionController::fraction_to_jerk`, and
it has no state machine, no torque, and no position clamping against a board.
Treat the graph as a very good prediction, not a bit-exact replay.

## Returning arrays to JavaScript

```rust
pub fn record(&self, pattern: usize, depth: f64, stroke: f64, velocity: f64,
              sensation: f64, max_samples: usize) -> TrajectoryResult
```

```rust
#[wasm_bindgen]
pub struct TrajectoryResult {
    position: Box<[f32]>,
    velocity: Box<[f32]>,
    acceleration: Box<[f32]>,
}

#[wasm_bindgen]
impl TrajectoryResult {
    #[wasm_bindgen(getter)]
    pub fn position(&self) -> Box<[f32]> { self.position.clone() }
    // velocity, acceleration likewise
}
```

`Box<[f32]>` is a heap-allocated slice of known length. `wasm-bindgen` maps it
to a JavaScript `Float32Array`, copying the bytes out of the WASM linear
memory. `#[wasm_bindgen(getter)]` makes it a property access on the JS side —
`result.position`, not `result.position()`.

The consumer converts to plain arrays for the chart:

```ts
const result = rec.record(pattern, depth, stroke, velocity, sensation, totalSteps);
return {
  time,
  position: Array.from(result.position),
  velocity: Array.from(result.velocity),
  acceleration: Array.from(result.acceleration),
};
```

## Pattern list, again

```rust
pub fn pattern_count(&self) -> usize { AnyPattern::BUILTIN_PATTERNS.len() }
pub fn pattern_name(&self, index: usize) -> String { /* ... */ }
```

Both bindings expose the same list from the same const array, so pattern
indices are guaranteed consistent between the 3D view and the graph.

## Where to go next

- How both modules are loaded and driven: [22-web-tools-frontend.md](22-web-tools-frontend.md)
