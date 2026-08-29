# Rust: `Option`, `Result`, and `?`

There are no exceptions. Failure is a value, in the return type, and the
compiler makes you deal with it.

## `Option<T>` — maybe there is a value

```rust
enum Option<T> { Some(T), None }
```

This replaces `nullptr`, sentinel values, and `std::optional`. A `&T` is never
null; if something may be absent, its type says so.

```rust
pub struct MotionCommand {
    /// Torque limit as a fraction (0.0–1.0). `None` uses the motor default.
    pub torque: Option<f64>,
}
```

You cannot use the inner value without handling `None`:

```rust
let fraction = self.target.as_ref().and_then(|t| t.torque).unwrap_or(1.0);
```

- `as_ref()` — `&Option<T>` → `Option<&T>`, so we borrow rather than move.
- `and_then(f)` — if `Some(x)`, call `f(x)` (which itself returns an `Option`);
  if `None`, stay `None`. Monadic bind, if you like; "flat map" otherwise.
- `unwrap_or(1.0)` — the value, or this default.

Other forms you will see:

```rust
if let Some(cmd) = self.receiver.try_recv_motion() { /* ... */ }

let Some(pat) = patterns.get_mut(pattern) else {
    return TrajectoryResult::empty();      // let-else: bind, or take the escape route
};

opt.map(String::from).unwrap_or_default()
```

## `Result<T, E>` — it may have failed

```rust
enum Result<T, E> { Ok(T), Err(E) }
```

Every fallible operation in this codebase returns one. `#[must_use]` is on
`Result`, so ignoring one is a warning — you have to say `let _ = ...` to
discard it deliberately, which the code does in a few well-commented places:

```rust
let _ = self.channels.move_cmd.try_receive();   // intentionally drop a stale command
let _ = self.write_register(RwRegister::ModbusEnable, 506).await;  // no response expected
```

## `?` — the propagation operator

```rust
self.tick().await?;
```

means: if `Err(e)`, return `Err(e)` from the enclosing function right now;
otherwise unwrap the `Ok` and continue. It is the closest thing to exception
propagation, except it is visible at every site and only works where the
function's return type agrees.

This is what makes patterns readable:

```rust
async fn run(&mut self, ctx: &mut PatternCtx<'_, impl DelayNs>) -> Result<(), Cancelled> {
    loop {
        ctx.motion().position(1.0).send().await?;
        ctx.motion().position(0.0).send().await?;
    }
}
```

An infinite loop with two exit points, both marked. When a state command
cancels the in-flight move, `send()` returns `Err(Cancelled)` and `?` unwinds
the pattern out of its loop. No `if (stopRequested) return;` needed anywhere.

`?` also works on `Option` (returning `None`), which is why you sometimes see
functions returning `Option<T>` just to use it.

## Converting error types

`?` applies `From` conversion automatically, which is how layered errors
compose. Where an automatic conversion is not defined, the code maps
explicitly:

```rust
self.motor.enable().await.map_err(BoardError::Motor)
```

`map_err` transforms the error and leaves `Ok` alone. `BoardError::Motor` is
used here as a *function* — an enum variant constructor is callable, so
`BoardError::Motor` is shorthand for `|e| BoardError::Motor(e)`.

## Error types are usually enums

```rust
pub enum TransportError<E: core::fmt::Debug> {
    Uart(E),
    Timeout,
    /// Wire corruption: garbled header, CRC mismatch, etc. Retryable.
    Corrupt(&'static str),
    /// Logic/programming error: failed to build request, buffer too small. Fatal.
    Protocol(&'static str),
}
```

Variants carry data. Callers `match` on them and the compiler checks
exhaustiveness — the Modbus retry loop distinguishes retryable from fatal
exactly this way:

```rust
match self.exchange(&request, &mut response).await {
    Ok(len) => { /* ... */ }
    Err(TransportError::Timeout | TransportError::Corrupt(_)) => { /* retry */ }
    Err(e) => return Err(e),      // fatal, give up
}
```

## `Infallible`

```rust
impl Board for SimBoard {
    type Error = Infallible;
}
```

An enum with no variants: a value of this type cannot be constructed, so a
function returning `Result<(), Infallible>` cannot fail, and the compiler
optimises the error path away entirely.

## Panics

`panic!`, `unwrap()`, `expect("...")` and out-of-bounds indexing abort the
program. This codebase reserves them for genuinely unrecoverable boot-time
conditions:

```rust
.expect("Failed to initialize UART")
panic!("Power cycle required after motor baud provisioning");
assert!(system.perip_clk_en0().read().uart1_clk_en().bit_is_set(),
        "UART1 peripheral clock is not enabled - call Uart::new() first");
```

Each is a case where continuing would be meaningless. Nothing in the running
control loop panics; runtime faults become `Result` values and drive the state
machine into `Disabled`.

## The philosophy, versus C++

- No exceptions, so no exception-safety analysis and no hidden control flow.
- No error codes to forget, because `Result` is `#[must_use]`.
- The signature tells you exactly what can fail and how.
- Recoverable (`Result`) and unrecoverable (`panic!`) are different mechanisms,
  chosen deliberately.
