# Rust: traits and generics

A trait is an interface. `impl Trait for Type` is how a type implements it.

```rust
pub trait Board {
    type Error: Debug;
    async fn set_position(&mut self, position_mm: f64) -> Result<(), Self::Error>;
    // ...
}

impl Board for SimBoard {
    type Error = Infallible;
    async fn set_position(&mut self, position_mm: f64) -> Result<(), Self::Error> { /* ... */ }
}
```

## Differences from a C++ abstract base class

**The impl is separate from the type.** `SimBoard` does not inherit from
anything; the `impl` block is written separately and can even live in a
different crate from the struct. There is no vtable pointer in the object, no
layout impact, no base class.

**Dispatch is static by default.** `MotionController<'a, B: Board>` is generic
over `B`. The compiler generates a separate copy of the controller for each
concrete board and inlines the calls — like a C++ template, but the constraint
`B: Board` is checked *when the generic is defined*, not when it is
instantiated. That means no 200-line template error messages: if `B: Board` is
satisfied, the body compiles.

Dynamic dispatch exists (`&dyn Board`) but is opt-in and rarely used here.

**No inheritance, only composition.** A trait can require another trait:

```rust
pub trait Rs485Motor: Motor { /* ... */ }
pub trait SelfHoming: Motor { /* ... */ }
```

That is a *supertrait bound*: you cannot implement `Rs485Motor` without also
implementing `Motor`. It reads like inheritance but it only constrains, it
does not bring in data or layout.

## Bounds as requirements

A type declares what it needs:

```rust
pub struct Rs485Board<M: Rs485Motor + SelfHoming> {
    motor: M,
    mechanical: &'static MechanicalConfig,
}
```

`M: Rs485Motor + SelfHoming` — "any type that implements both". Hand it a
motor that cannot home itself and the error is at the construction site, naming
the missing trait. There is no runtime capability flag anywhere in this
codebase because the bounds carry that information.

## Associated types

```rust
pub trait Board {
    type Error: Debug;
}
```

Each implementor picks *one* error type. That is different from a generic
parameter (`trait Board<E>`), which would allow many. Callers write
`B::Error`; the `MotionController` returns `Result<(), B::Error>` and never
needs to know what it is.

The nicest consequence: `SimBoard::Error = Infallible`, an enum with **no
variants**. A value of that type cannot exist, so the compiler proves every
error branch dead and deletes it. Error handling for the simulator costs
literally nothing.

## `impl Trait`

Two positions, two meanings:

```rust
// argument position: "any type implementing DelayNs" — sugar for a generic parameter
async fn run(&mut self, ctx: &mut PatternCtx<'_, impl DelayNs>) -> Result<(), Cancelled>;

// return position: "some concrete type I'm not naming"
fn make_delay() -> impl DelayNs { embassy_time::Delay }
```

## Const generics

Sizes can be type parameters:

```rust
pub async fn run<const N: usize, D: DelayNs + Clone>(
    &self, motion: &MotionSender, mut patterns: [AnyPattern; N], delay: D,
) -> !
```

`N` is the number of patterns, known at compile time. So the runner's bounds
check `if new_idx < N` compares against a constant, and there is no `Vec`, no
heap, and no length field.

`-> !` is the never type: this function never returns.

## Traits you will see everywhere

- `Debug` / `Display` — formatting. `{:?}` uses `Debug`, `{}` uses `Display`.
- `Clone` / `Copy` — duplication. `Copy` is implicit and bitwise; `Clone` is explicit.
- `Default` — `Type::default()`.
- `From` / `Into` — conversions. `impl From<A> for B` automatically gives you `a.into()`.
- `Iterator` — anything you can loop over.

`#[derive(Debug, Clone, Copy, PartialEq)]` above a struct asks the compiler to
generate those impls; see [07-macros.md](07-macros.md).

## `async fn` in traits

```rust
#[allow(async_fn_in_trait)]
pub trait Board { async fn enable(&mut self) -> Result<(), Self::Error>; }
```

Async functions in traits are stable, but the returned future is not
automatically `Send`. The lint warns about that because it limits use in
multi-threaded executors; on a single-core MCU it is irrelevant, so the repo
silences it. You will see that `#[allow]` on every async trait here.
