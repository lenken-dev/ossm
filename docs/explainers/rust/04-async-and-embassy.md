# Rust: async/await and Embassy

The concurrency model of this firmware. There are no threads and no RTOS task
scheduler in the traditional sense.

## What `async` actually compiles to

An `async fn` does not run when called. It returns a **future**: a value with
one method.

```rust
trait Future {
    type Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;
}

enum Poll<T> { Ready(T), Pending }
```

The compiler transforms the function body into a state machine struct: one
variant per `.await` point, with every local variable that lives across an
await stored as a field. Calling `poll` runs from the last suspension point to
the next one.

This is exactly the hand-written state machine you would write in C++ for a
non-blocking driver, except the compiler writes it, and the "context" is real
local variables rather than members you have to invent names for.

The size of the state machine is known at compile time. No heap. That is what
makes async viable on a microcontroller.

The trajectory recorder polls a future by hand, which makes the whole mechanism
visible — see [../21-trajectory-recorder.md](../21-trajectory-recorder.md), and
its eight-line `YieldOnce` future.

## Executors

A future does nothing until something polls it. An **executor** is the loop
that polls futures and goes to sleep when they are all `Pending`. When a future
returns `Pending` it has arranged, via the `Waker` in the `Context`, to be
woken — typically by a timer or a peripheral interrupt.

Three executors appear in this project:

| Where | Executor | Notes |
| --- | --- | --- |
| ESP32-S3 core 0 | `esp_rtos` default executor | pattern engine, BLE, ESP-NOW |
| ESP32-S3 core 1 | `InterruptExecutor` at `Priority::Priority2` | the 10 ms motion loop |
| Browser | `wasm_bindgen_futures::spawn_local` | microtask queue |
| Recorder | a hand-written `while` loop | simulated time |

The point of the interrupt executor is that it preempts the default one — a
busy Bluetooth stack cannot delay a Ruckig tick. See
[../30-ossm-alt.md](../30-ossm-alt.md).

## Tasks

```rust
#[embassy_executor::task]
async fn motion_task(mut controller: MotionController<'static, board::Board>) {
    let mut ticker = Ticker::every(Duration::from_micros(10_000));
    loop {
        if let Err(e) = controller.update().await { log::error!("{:?}", e); }
        ticker.next().await;
    }
}

spawner.spawn(motion_task(controller)).unwrap();
```

The attribute macro allocates storage for the task's future in a static, sized
at compile time. No heap, no per-task stack — all tasks on one executor share
one stack, because a suspended future's state lives in its own struct, not on
the stack.

`Ticker::every` fires on a fixed schedule and, importantly, does not drift: it
tracks absolute deadlines rather than sleeping for a fixed duration after the
work finishes.

## Embassy synchronisation primitives

`embassy-sync` provides small, lock-free-ish, `no_std` primitives. Which one to
use is a design decision that appears repeatedly in this codebase:

| Primitive | Semantics | Used for |
| --- | --- | --- |
| `Channel<M, T, N>` | bounded queue, N slots | commands (`StateCommand`, `EngineCommand`) |
| `Signal<M, T>` | single slot, latest value, awaitable | responses (`StateResponse`, move completion) |
| `Watch<M, T, N>` | single slot, latest wins, N receivers | live inputs (depth/stroke/velocity/sensation) |
| `PubSubChannel<M, T, CAP, SUBS, PUBS>` | broadcast to many | phase / engine-state transitions |
| `Mutex<M, Cell<T>>` | guarded cell | the current `MotionState` snapshot |

The `M` parameter is the *raw mutex kind*. This project uses
`CriticalSectionRawMutex` almost everywhere: locking briefly disables
interrupts, making the primitive safe to use from an interrupt handler and
across the two CPU cores. In the browser it compiles to a no-op, because WASM
is single-threaded.

Choosing a channel of capacity 1 and *draining before sending* gives
latest-wins semantics for motion targets:

```rust
pub fn begin_motion(&self, cmd: MotionCommand) {
    self.channels.move_resp.reset();
    let _ = self.channels.move_cmd.try_receive();   // drop the stale one
    let _ = self.channels.move_cmd.try_send(cmd.clamped());
}
```

`try_send` / `try_receive` are the non-blocking variants — essential inside
the motion tick, which must never wait.

## `select` — race several futures

```rust
match select::select3(
    move_done.as_mut(),                  // controller finished the move
    self.ctx.input_receiver.changed(),   // slider moved
    throttle.next(),                     // 250 ms ticker
).await
{
    Either3::First(result)     => return result,
    Either3::Second(new_input) => { pending = Some(new_input); }
    Either3::Third(())         => { /* apply the pending input */ }
}
```

`select` polls all its futures and returns as soon as one completes, as an
`Either` enum you must match — the compiler will not let you forget a branch.
The losing futures are dropped, which is how cancellation works in Rust: there
is no "kill this task" call, you simply stop polling a future and drop it.

That is why `PatternRunner` can stop a pattern instantly:

```rust
let pattern_fut = core::pin::pin!(patterns[idx].run(&mut ctx));
match select::select(pattern_fut.as_mut(), engine.commands.receive()).await { /* ... */ }
```

If a command arrives first, the pattern future is simply not polled again.

## `Pin`

A future can hold references into its own storage (a borrow held across an
`.await`), so it must not move in memory after it has been polled. `Pin<&mut F>`
is the type-level promise that it will not. `pin!(fut)` pins a future to the
current stack frame; `fut.as_mut()` re-borrows it for each poll.

You need it exactly when you hold a future as a value and poll it more than
once, which is precisely the `select` loops above.

## Async is not parallelism

One core, one executor, cooperative scheduling. A future that computes for
15 ms without awaiting blocks everything else on that executor for 15 ms. That
is why:

- the Ruckig replan throttle exists (a replan costs 5–15 ms);
- input updates are limited to ~4 Hz;
- the motion loop lives on a separate core at a higher priority.
