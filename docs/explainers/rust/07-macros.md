# Rust: macros

Rust macros operate on the *token stream* after parsing, not on text. They
cannot produce unbalanced braces, cannot capture identifiers from the call
site by accident, and their output is type-checked normally. They are much
closer to a compiler plugin than to the C preprocessor.

Three kinds appear in this codebase.

## 1. Function-like macros

Called with `!`. Standard ones you have already seen: `println!`, `format!`,
`log::info!`, `assert!`, `panic!`, `vec!`, `include_bytes!`, `concat!`,
`env!`, `compile_error!`.

### `macro_rules!` — declarative macros

Pattern matching on syntax. This is how the pattern registry works:

```rust
macro_rules! define_patterns {
    ($( $variant:ident($type:ident) ),+ $(,)?) => {
        pub enum AnyPattern {
            $( $variant($type), )+
        }

        impl AnyPattern {
            pub const BUILTIN_PATTERNS: [PatternMeta; define_patterns!(@count $($variant)+)] = [
                $( PatternMeta { name: $type::NAME, description: $type::DESCRIPTION }, )+
            ];

            pub fn all_builtin() -> [AnyPattern; define_patterns!(@count $($variant)+)] {
                [ $( AnyPattern::$variant($type), )+ ]
            }
        }

        impl Pattern for AnyPattern {
            async fn run(&mut self, ctx: &mut PatternCtx<'_, impl DelayNs>)
                -> Result<(), ossm::Cancelled>
            {
                match self { $( Self::$variant(p) => p.run(ctx).await, )+ }
            }
        }

        $( impl From<$type> for AnyPattern {
            fn from(p: $type) -> Self { Self::$variant(p) }
        } )+
    };

    (@count $($t:tt)+) => { 0 $( + define_patterns!(@one $t) )+ };
    (@one $t:tt) => { 1 };
}
```

Reading it:

- `$variant:ident` — capture a token and assert it is an identifier. Other
  *fragment specifiers* include `expr`, `ty`, `literal`, `block`, `tt` (any
  token tree), `path`.
- `$( ... ),+` — one or more repetitions, comma separated. In the body,
  `$( ... )+` expands once per captured repetition.
- `$(,)?` — allow an optional trailing comma.
- `@count` / `@one` — an internal-rule convention. `@` is not special; it is
  just a token that cannot start a real invocation, used to add private
  "functions" to the macro. Here they count the repetitions at compile time so
  the arrays get a fixed length.

Called as:

```rust
define_patterns! {
    Simple(Simple),
    Deeper(Deeper),
    // ...
}
```

one line per pattern generates an enum, a `Pattern` impl that dispatches by
`match`, `From` impls, a metadata array, and a constructor array. Adding a
pattern is one line, and it appears in the firmware, the BLE list, and both
web pages automatically.

Note `include!("any_pattern_macro.rs")` in `lib.rs` — a literal source
inclusion, used here to keep the macro in its own file while it is defined at
the crate root where `define_patterns!` needs to be in scope.

### The `mk_static!` idiom

```rust
macro_rules! mk_static {
    ($t:ty, $val:expr) => {{
        static STATIC_CELL: ::static_cell::StaticCell<$t> = ::static_cell::StaticCell::new();
        STATIC_CELL.init($val)
    }};
}
```

Each expansion creates a *new* `static`. A function cannot do that — the
static would be shared across all calls. That is the canonical reason to reach
for a macro here.

The leading `::` in `::static_cell::StaticCell` forces an absolute path, so the
macro works regardless of what is in scope at the call site. Macros are
"partially hygienic": local variables the macro introduces cannot collide with
the caller's, but paths to items must still be written carefully.

### `build_info!`

```rust
#[macro_export]
macro_rules! build_info {
    () => {{
        #[unsafe(link_section = ".ossm.build_info")]
        #[used]
        static OSSM_BUILD_META: $crate::BuildMeta = $crate::BuildMeta::new(
            include_bytes!(concat!(env!("OUT_DIR"), "/ossm_build_info.bin")),
        );
        log::info!("{} {} (release: {}, built: {})", /* ... */);
    }};
}
```

`#[macro_export]` publishes the macro at the crate root. `$crate` expands to
the defining crate's path, so the macro works in any consumer. `env!("OUT_DIR")`
is resolved *at the call site*, which is the point — each firmware crate's own
`build.rs` output gets baked in.

## 2. Derive macros

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MotionCommand { /* ... */ }
```

`derive` asks the compiler (or a proc-macro crate) to generate a trait impl
from the type's shape. Extremely common — this is why almost every struct in
the codebase has a `#[derive(...)]` line and no hand-written `operator==` or
printing code.

## 3. Attribute macros

These *replace* the item they annotate with generated code. They are ordinary
Rust functions running at compile time (procedural macros).

```rust
#[esp_rtos::main]                    // generates the reset handler + starts an executor
async fn main(spawner: Spawner) { /* ... */ }

#[embassy_executor::task]            // allocates the future's storage in a static
async fn motion_task(mut c: MotionController<'static, board::Board>) { /* ... */ }

#[wasm_bindgen]                      // emits JS binding metadata into the wasm module
pub struct Simulator { /* ... */ }

#[gatt_service(uuid = SERVICE_UUID)] // builds a BLE GATT service definition
struct OssmService { /* ... */ }
```

That is how `async fn main` can exist on a chip with no operating system, and
how a Rust struct becomes a JavaScript class — see
[08-wasm-bindgen.md](08-wasm-bindgen.md).

## Attributes that are not macros

Also spelled `#[...]`, but instructions to the compiler rather than code
generators:

```rust
#[repr(u16)]                 // fix the enum's representation, so `reg as u16` is the address
#[allow(async_fn_in_trait)]  // silence one lint for this item
#[used]                      // don't let the linker garbage-collect this static
#[unsafe(link_section = ".ossm.build_info")]   // place it in a named ELF section
#![no_std]                   // `#![...]` (with `!`) applies to the enclosing item/crate
```

## Seeing what a macro produced

```sh
cargo install cargo-expand
cargo expand --package pattern-engine
```

Prints the crate with all macros expanded. The fastest way to demystify
`define_patterns!` or `#[embassy_executor::task]`.
