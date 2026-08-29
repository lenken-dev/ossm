# 10 — The core `ossm` crate

> Prerequisites: [rust/01-ownership-and-borrowing.md](rust/01-ownership-and-borrowing.md),
> [rust/04-async-and-embassy.md](rust/04-async-and-embassy.md)

`ossm/` is the heart of the project: a `no_std`, hardware-agnostic crate that
owns the motion state machine and the trajectory planning. It compiles for
ESP32, ESP32-S3 and `wasm32-unknown-unknown` from identical source.

## The `Ossm` handle and the split

`Ossm` itself does nothing. It is a container for four communication
primitives:

```rust
pub struct Ossm {
    pub(crate) move_cmd: MoveChannel,              // Channel<_, MotionCommand, 1>
    pub(crate) state_cmd: StateChannel,            // Channel<_, StateCommand, 1>
    pub(crate) state_resp: StateResponseSignal,    // Signal<_, StateResponse>
    pub(crate) move_resp: MoveResponseSignal,      // Signal<_, Result<(), Cancelled>>
    pub(crate) motion_state: MotionStateChannels,  // current state + phase pubsub
}
```

You never use an `Ossm` directly. You immediately split it into three
*capability handles*:

```rust
let (receiver, observer, sender) = OSSM_CELL.init(Ossm::new()).split();
```

| Handle | Can do |
| --- | --- |
| `MotionSender` | `enable`, `disable`, `home`, `pause`, `resume`, `begin_motion`, `await_motion` — plus reading state |
| `MotionObserver` | read state, subscribe to phase transitions. Nothing else. |
| `MotionReceiver` | consumed once, at boot, to build the `MotionController` |

### Why this shape

This is the single most important idiom in the codebase, and it has no direct
C++ analogue, so it is worth dwelling on.

```rust
pub fn split(&'static mut self) -> (MotionReceiver, MotionObserver, MotionSender)
```

`&'static mut self` means "a **unique**, exclusive reference to something that
lives for the whole program". Rust's borrow checker guarantees at compile time
that at most one such reference to a given object can exist. `split` consumes
it. Therefore `split` can be called **at most once per `Ossm`**, and there can
never be two `MotionSender`s or two `MotionController`s for the same channels.

In C++ you would enforce that with a singleton, a runtime flag, and a code
review. Here the compiler enforces it and the check costs nothing at runtime.

The handles are also not `Clone` and have no public constructor. The
consequence is a *capability model*: a function that takes `&MotionObserver`
is structurally incapable of moving the motor, no matter what it does. The
signature is the security boundary.

The pattern engine uses the exact same shape (`PatternEngine::split` →
`PatternRunner` / `PatternObserver` / `PatternSender`); see
[13-pattern-engine.md](13-pattern-engine.md).

> **Important caveat, stated in the source:** dropping a `MotionSender` does
> not stop the motor. The motor is powered as long as the firmware runs, and
> the controller owns the pins for the program's lifetime. To stop motion you
> must send `disable()` or `pause()`. There is no RAII shutdown here.

## The two command paths

There are deliberately two, with different delivery semantics:

**State commands** — request/response. `send_state` resets the response
signal, pushes the command, and awaits the reply:

```rust
async fn send_state(&self, cmd: StateCommand) -> StateResponse {
    self.channels.state_resp.reset();
    self.channels.state_cmd.send(cmd).await;
    self.channels.state_resp.wait().await
}
```

`StateResponse` is `Completed`, `InvalidTransition`, or `Fault`.

**Motion commands** — latest-wins, fire and forget:

```rust
pub fn begin_motion(&self, cmd: MotionCommand) {
    self.channels.move_resp.reset();
    let _ = self.channels.move_cmd.try_receive();   // drop any stale command
    let _ = self.channels.move_cmd.try_send(cmd.clamped());
}
```

The channel has capacity 1 and the sender *drains it first*. A new target
replaces an unread old one rather than queueing behind it. That is the right
semantics for "go here now": if the UI moved the depth slider three times
while the controller was busy, only the newest position matters. Note also
`.clamped()` — every value is forced into 0.0–1.0 at the boundary.

`begin_motion` is not `async` and never blocks. `await_motion()` is the
separate call that waits for completion, and it returns
`Result<(), Cancelled>` — `Err(Cancelled)` when a state command (disable,
home) interrupted the move. Patterns propagate that with `?` to exit cleanly;
see [rust/03-error-handling.md](rust/03-error-handling.md).

## The motion state machine

`MotionController` (`ossm/src/motion.rs`, ~500 lines) is the only thing that
touches the board.

```
                 Enable                 Home
   Disabled ──────────────▶ Enabled ──────────────▶ Ready
      ▲                        │                      │
      │                        │ Disable              │ MotionCommand
      │◀───────────────────────┘                      ▼
      │                                            Moving
      │       Stopping(Disable)  ◀── Disable ─────────┤
      └──────────────────────────                     │ Pause
                                                      ▼
                          Paused  ◀── Stopping(Pause) ─┘
                             │ Resume
                             └──────────▶ Moving
```

`Stopping(reason)` is the interesting state. A "stop" is never abrupt: the
controller switches Ruckig from position control to *velocity* control with a
target velocity of zero, and lets the planner produce a jerk-limited
deceleration curve. When that curve finishes, the stored reason decides what
happens next:

```rust
fn stop(&mut self, reason: StopReason) {
    // Switch to velocity control and target zero velocity. Ruckig handles
    // the jerk-limited deceleration trajectory — no manual math needed.
    self.input.control_interface = ControlInterface::Velocity;
    self.input.target_velocity[0] = 0.0;
    self.output.time = 0.0;
    self.transition(MotionState::Stopping(reason));
}
```

The transition table is expressed as a `match` on the *pair* `(current state,
command)`:

```rust
match (&self.state, cmd) {
    (MotionState::Disabled, StateCommand::Enable) => { /* ... */ }
    (MotionState::Enabled | MotionState::Ready, StateCommand::Disable) => { /* ... */ }
    (MotionState::Moving, StateCommand::Disable) => {
        self.channels.move_resp.signal(Err(Cancelled));
        self.stop(StopReason::Disable);
    }
    // ...
    _ => { self.respond(StateResponse::InvalidTransition); }
}
```

Rust's `match` is an exhaustive pattern match, not a `switch`. It can destructure
tuples and enums, bind values (`Stopping(reason)`), and combine alternatives
with `|`. The `_` arm catches every unlisted combination and answers
`InvalidTransition` rather than doing something undefined — so a remote that
spams `Enable` while homing gets a clean rejection.

## The tick

`update()` is called every 10 ms by whoever owns the controller. It does four
things in a fixed order:

```rust
pub async fn update(&mut self) -> Result<(), B::Error> {
    if let Err(e) = self.board.tick().await {      // 1. board housekeeping / fault poll
        log::error!("Board tick fault: {:?}", e);
        self.enter_fault();
        return Err(e);
    }

    self.tick().await?;                             // 2. sample trajectory, drive board

    if let Ok(cmd) = self.channels.state_cmd.try_receive() {
        self.process_state_command(cmd).await?;     // 3. state commands
    }

    if let Ok(cmd) = self.channels.move_cmd.try_receive() {
        self.process_move_command(cmd).await;       // 4. motion commands
    }

    Ok(())
}
```

Steps 3 and 4 use `try_receive`, not `receive().await` — the tick must never
block waiting for a command. The one place that *is* allowed to block is
homing, which runs to completion inside `process_state_command` and can take
seconds; during homing no position commands are sent at all.

Note `B::Error`: the controller is generic over `B: Board`, and the error type
comes from the board. On the simulator that type is `core::convert::Infallible`
— an enum with no variants — so the compiler can prove those error branches are
dead and delete them.

Inner `tick()` is where a movement actually happens:

```rust
let result = self.ruckig.update(&self.input, &mut self.output)?;
let mm = self.output.new_position[0]
    .clamp(self.limits.min_position_mm, self.limits.max_position_mm);
self.board.set_position(mm).await?;
self.output.pass_to_input(&mut self.input);   // feed this tick's output back as next tick's input
self.publish_state();
```

The `clamp` is the last line of defence: even if the planner produced garbage,
the board is never asked to leave the mechanical range.

## Observability

State goes out on two different primitives, for two different consumers:

- `MotionState` (phase, position, velocity, acceleration, torque, all as
  fractions) lives in a `Mutex<Cell<MotionState>>` and is read with `.get()`.
  Cheap polling for anyone who wants "the value right now" — the 3D view in
  the browser reads this every animation frame.
- `MotionPhase` transitions are broadcast on a `PubSubChannel` with capacity
  1 and 8 subscriber slots. Async consumers `.await` the next transition.

Both are exposed by `MotionObserver` and (for convenience) by `MotionSender`.

## Where to go next

- How the trajectory is actually computed: [11-trajectory-planning.md](11-trajectory-planning.md)
- What is below the `Board` line: [12-boards-and-motors.md](12-boards-and-motors.md)
- What is above it: [13-pattern-engine.md](13-pattern-engine.md)
