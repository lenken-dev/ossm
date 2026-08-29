# Rust: `no_std`, statics, interior mutability, `unsafe`

## `#![no_std]`

```rust
#![no_std]
extern crate alloc;
```

`no_std` opts out of the standard library and uses `core` instead: language
fundamentals only — `Option`, `Result`, slices, iterators, `f64` methods,
atomics. What you lose is everything that assumes an OS: `Vec`, `String`,
`HashMap`, file I/O, threads, and `std::time`.

`extern crate alloc;` opts back in to heap types (`Vec`, `String`, `Box`) *if*
the program provides an allocator. The ESP firmware does
(`esp_alloc::heap_allocator!(size: 128 * 1024)`), because Ruckig's `alloc`
feature needs it and the radio stacks want it. The core `ossm` crate uses
`alloc` sparingly and mostly avoids the heap entirely.

Equivalent framing: `core` is roughly "the language plus freestanding
headers"; `std` is "the language plus an OS".

## Fixed-capacity collections

The usual `no_std` substitute is `heapless`, whose types carry their capacity
in the type:

```rust
use heapless::Vec;

async fn read_holding(&mut self, /* ... */) -> Result<Vec<u16, 8>, Self::Error>;

let mut request: Vec<u8, 32> = Vec::new();
let mut buf = heapless::String::<256>::new();
```

`Vec<u16, 8>` stores 8 `u16`s inline plus a length. Pushing beyond capacity
returns an `Err` instead of allocating. No allocator, no fragmentation, and the
worst-case memory use is visible in the type.

## Why globals are hard, and `StaticCell`

Rust forbids mutable globals in safe code, because two references to a `static
mut` would be a data race. But firmware genuinely needs objects that live
forever and are shared between tasks.

`StaticCell` resolves this:

```rust
static OSSM_CELL: StaticCell<Ossm> = StaticCell::new();

let (receiver, observer, sender) = OSSM_CELL.init(Ossm::new()).split();
```

The cell holds uninitialised storage in `.bss`. `init(value)` writes the value
and returns `&'static mut T` — a *unique* reference with static lifetime. It
can only succeed once; a second call panics. So you get a forever-lived object
and a uniqueness proof, safely.

That `&'static mut` is precisely what `Ossm::split` and `PatternEngine::split`
require, which is how "split can be called at most once" is enforced. See
[01-ownership-and-borrowing.md](01-ownership-and-borrowing.md).

There is a convenience macro for one-liners:

```rust
macro_rules! mk_static {
    ($t:ty, $val:expr) => {{
        static STATIC_CELL: ::static_cell::StaticCell<$t> = ::static_cell::StaticCell::new();
        STATIC_CELL.init($val)
    }};
}

let patterns: &'static PatternSender = mk_static!(PatternSender, patterns);
```

The macro creates a fresh `static` at each expansion site — you cannot write
that as a function.

## Immutable statics that are still useful

```rust
static MECHANICAL: MechanicalConfig = MechanicalConfig {
    pulley_teeth: 20,
    belt_pitch_mm: 2.0,
    reverse_direction: false,
};

let board = SimBoard::new(motor, &MECHANICAL);
```

An immutable `static` is fine in safe code, and `&'static MechanicalConfig` can
be shared anywhere. This is why boards hold a `&'static MechanicalConfig`
rather than a copy.

`const` is different: it is inlined at each use site rather than having an
address. `MotionLimits::DEFAULT` is a `const`; `MECHANICAL` is a `static`.

## Interior mutability

Sometimes you must mutate through a shared reference — that is what all the
channels do. Rust allows it through types that enforce the rule at runtime
instead of compile time.

```rust
pub(crate) struct MotionStateChannels {
    state: Mutex<CriticalSectionRawMutex, Cell<MotionState>>,
    phase: PhaseChannel,
}

pub(crate) fn update(&self, new_state: MotionState) {   // note: &self, not &mut self
    self.state.lock(|cell| cell.set(new_state));
}
```

- `Cell<T>` — get/set by value, no borrows handed out, so no aliasing rule to
  break. Zero overhead.
- `Mutex<RawMutex, T>` — Embassy's *blocking* mutex; `lock` takes a closure and
  the critical section is the closure body. `CriticalSectionRawMutex` briefly
  disables interrupts, which is what makes this safe from an interrupt handler
  and across the two CPU cores.

Atomics are the other tool, used where a lock would be overkill:

```rust
pub(crate) state: AtomicU16,

engine.state.store(state.encode(), Ordering::Relaxed);
EngineState::decode(self.engine.state.load(Ordering::Relaxed))
```

`Ordering::Relaxed` — no synchronisation guarantees beyond atomicity of this
one value, which is all that is needed for a status field that is polled. This
is why the WASM `get_engine_state()` is free to call every animation frame.

## `unsafe`

`unsafe` does not turn off the borrow checker. It unlocks five extra abilities,
chiefly: dereferencing raw pointers, calling `unsafe` functions, and accessing
`static mut`. Writing `unsafe` is a claim that *you* have checked an invariant
the compiler cannot.

There are two `unsafe` regions in this codebase and both are the right kind.

**Peripheral registers** — writing UART, IO_MUX and GPIO-matrix registers
behind the HAL's back to enable hardware RS-485 mode:

```rust
/// # Safety
///
/// Writes directly to UART1, IO_MUX, and GPIO matrix registers. UART1
/// must be initialised before calling this function.
pub unsafe fn enable_uart1_rs485(de_pin: impl OutputPin) { /* ... */ }
```

The call site documents why the invariant holds, and the function itself
asserts what it can:

```rust
// Safety: `enable_uart1_rs485` requires UART1 to be initialised; `Uart::new`
// above satisfies that, and we own `config.uart1` so no other code is
// touching UART1 registers concurrently.
unsafe { crate::rs485::enable_uart1_rs485(config.rs485_de) };
```

**A function pointer in an atomic** — the logger stores its output sink in an
`AtomicPtr` so `init` can be called from anywhere, then transmutes it back:

```rust
static WRITE_FN: AtomicPtr<()> = AtomicPtr::new(core::ptr::null_mut());

let write_fn: WriteFn = unsafe { core::mem::transmute(write_fn) };
```

That is how the same logger writes to `esp_println` on hardware and
`console.log` in the browser with no `cfg` in the core crate.

The convention throughout: an `unsafe fn` carries a `# Safety` doc section
listing its preconditions, and every `unsafe {}` block carries a comment
explaining why they hold.
