# Rust: ownership, borrowing, lifetimes

The one thing you must internalise. Everything else in Rust is downstream of it.

## The rule

Every value has exactly one owner. When the owner goes out of scope, the value
is dropped. You may instead *borrow* a value:

- `&T` — shared borrow. Any number at a time. Read only.
- `&mut T` — exclusive borrow. Exactly one at a time, and no `&T` may coexist.

The compiler enforces this. There is no runtime cost and no garbage collector.

## Moves are the default

```rust
let a = String::from("hello");
let b = a;          // moved. `a` is now unusable.
println!("{}", a);  // compile error: borrow of moved value
```

C++ has moves too, but they are opt-in (`std::move`) and leave the source in a
valid-but-unspecified state. In Rust the move is the default for
non-`Copy` types, and the compiler *statically forbids* touching the source
afterwards. There is no moved-from state to reason about.

Small types like `i32`, `f64`, `bool` and simple structs marked `#[derive(Copy)]`
are copied instead of moved — `MotionCommand` is `Copy`, so passing it around
is free and never invalidates the original.

## This is used as an API design tool

Throughout this codebase, "consuming `self`" means "this can happen at most
once":

```rust
// ossm/src/receiver.rs
pub fn into_controller<B: Board>(self, board: B, limits: MotionLimits,
                                 update_interval_secs: f64) -> MotionController<'static, B>
```

`self`, not `&self`. Calling this consumes the `MotionReceiver`, so a second
`MotionController` for the same channels cannot be constructed. The comment in
the source says exactly that.

Similarly, `enable_uart1_rs485(de_pin: impl OutputPin)` takes the GPIO pin by
value so nothing can reconfigure it later, and `esp_hal`'s peripheral
singletons (`p.UART1`) can be moved into exactly one driver.

In C++ you would express these with a private constructor, a factory, an
`assert(!initialized)`, and a comment. Here the type system does it.

## Borrows in this codebase

```rust
pub struct PatternCtx<'m, D: DelayNs> {
    motion: &'m MotionSender,        // borrowed, not owned
    // ...
}
```

A pattern can command motion for exactly as long as the borrow lives. It
cannot store the sender in a global, hand it to another task, or outlive the
subsystem that lent it. The comment on `MotionSender` puts it well: "the borrow
expires with that subsystem, so a leaked stash is impossible."

## Lifetimes

`'m` and `'a` in signatures are **lifetime parameters**. They do not create
anything or cost anything; they let the compiler relate the lifetime of a
reference to the lifetime of the thing it points into.

```rust
pub struct MotionController<'a, B: Board> {
    board: B,               // owned
    channels: &'a Ossm,     // borrowed, lives at least as long as 'a
    // ...
}
```

Read it as: "a `MotionController` cannot outlive the `Ossm` it borrows."

Most of the time you never write lifetimes — the compiler infers them. They
appear in struct definitions because a struct holding a reference must declare
how long that reference is valid.

## `'static`

`'static` means "lives for the entire program". A `&'static Ossm` is a
reference that will never dangle, which is why it can be freely shared across
tasks, cores, and spawned futures.

`&'static mut T` is the strong one: a *unique* reference that lives forever.
Since it is unique, it cannot be duplicated; since it lives forever, it can be
stored anywhere. That is exactly the input `Ossm::split` demands:

```rust
pub fn split(&'static mut self) -> (MotionReceiver, MotionObserver, MotionSender)
```

You get one from `StaticCell` — see
[05-no-std-and-statics.md](05-no-std-and-statics.md).

## No `nullptr`, no dangling references

There is no null. Absence is `Option<T>` and must be unwrapped explicitly; see
[03-error-handling.md](03-error-handling.md). A reference is always valid,
always pointing at an initialised value of the right type. The class of bugs
you spend afternoons on in C++ — use-after-free, iterator invalidation, double
free, data race — is not reachable in safe Rust.

The escape hatch is `unsafe`, which appears in this repo exactly where it must:
raw peripheral register access, and a `transmute` in the logger. Each site
carries a comment stating the invariant the compiler cannot check.
