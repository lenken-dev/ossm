# Rust: `cdylib`, `wasm-bindgen`, and the JS boundary

How a Rust struct becomes a JavaScript class.

## The target

`wasm32-unknown-unknown`: 32-bit WebAssembly, no vendor, no OS. Bare metal, in
the same sense as the ESP targets — which is why the same `no_std` core crate
compiles for both. What differs is that the browser supplies the "hardware":
`setTimeout` for timers, `console.log` for output.

## `crate-type = ["cdylib"]`

```toml
[lib]
crate-type = ["cdylib"]
```

| Crate type | Produces |
| --- | --- |
| `lib` / `rlib` | a Rust library, linkable only by Rust |
| `cdylib` | a C-ABI dynamic library — for wasm, a `.wasm` module with exports |
| `bin` | an executable |

A raw `.wasm` module can only exchange numbers and a linear memory buffer with
JavaScript. Everything else — strings, structs, arrays, object lifetimes — has
to be marshalled by generated glue. That is what `wasm-bindgen` is.

## `#[wasm_bindgen]`

```rust
#[wasm_bindgen]
pub struct Simulator {
    motion_observer: MotionObserver,
    pattern_observer: PatternObserver,
    patterns: PatternSender,
}

#[wasm_bindgen]
impl Simulator {
    #[wasm_bindgen(constructor)]
    pub fn new(update_interval_ms: f64) -> Self { /* ... */ }

    pub fn get_position(&self) -> f32 { /* ... */ }
    pub fn set_depth(&self, depth: f64) { /* ... */ }
    pub fn pattern_name(&self, index: usize) -> String { /* ... */ }
}
```

The attribute macro does two things: it emits `extern "C"` shim functions the
wasm module exports, and it embeds a description of the API into a custom
section of the module. The `wasm-bindgen` CLI later reads that section and
writes the JavaScript glue and the TypeScript declarations.

Attribute variants used here:

- `#[wasm_bindgen(constructor)]` — becomes `new Simulator(10.0)` in JS.
- `#[wasm_bindgen(getter)]` — becomes a property: `result.position`, not
  `result.position()`.

## What can cross the boundary

Only types with a defined JS mapping:

| Rust | JavaScript |
| --- | --- |
| `f64`, `f32`, `i32`, `u8`, `usize` | `number` |
| `bool` | `boolean` |
| `String`, `&str` | `string` (copied) |
| `Box<[f32]>` | `Float32Array` (copied) |
| `Vec<T>` for primitive `T` | typed array |
| a `#[wasm_bindgen]` struct | a JS class instance holding a pointer |
| `JsValue` | anything, opaque |

Plain Rust structs like `MotionState` do **not** cross without extra work.
That is why the simulator's API is deliberately scalar:

```rust
pub fn get_engine_state(&self) -> u8 { self.pattern_observer.state().as_u8() }
pub fn get_position(&self) -> f32   { self.motion_observer.state().position }
```

`EngineState::as_u8()` flattens an enum-with-payload into one byte for exactly
this reason, and the TypeScript side mirrors the tag values by hand.

Returning arrays copies out of the WASM linear memory:

```rust
#[wasm_bindgen(getter)]
pub fn position(&self) -> Box<[f32]> { self.position.clone() }
```

→ `Float32Array` on the JS side. For a few thousand samples that copy is
irrelevant; for a per-frame data path you would instead read the wasm memory
buffer directly.

## Object lifetime across the boundary

A `#[wasm_bindgen]` struct instance lives in WASM memory; the JS object holds a
pointer to it. There is no shared garbage collector, so the glue exposes a
`free()` method and the object leaks if you drop the JS handle without calling
it.

This project sidesteps the issue: both the `Simulator` and the
`TrajectoryRecorder` are process-lifetime singletons (they `init` `StaticCell`s
that can only be initialised once), constructed once and kept in React context
or a module-level variable. Nothing is ever freed, which is correct here —
the "firmware" is supposed to run for the life of the page.

## Async across the boundary

```rust
wasm_bindgen_futures::spawn_local(async move {
    let mut ticker = Ticker::every(Duration::from_micros(interval_us));
    loop {
        controller.update().await;
        ticker.next().await;
    }
});
```

`spawn_local` drives a Rust future on the browser's microtask queue. It does
not require `Send` (WASM is single-threaded), which is what allows `&'static`
handles to be shared between the two spawned futures.

The reverse direction — a Rust `async fn` exported to JS — returns a
`Promise`; not used in this project, since JS only ever calls synchronous
getters and setters.

## The build pipeline

```sh
cargo +stable build --release
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/web_simulator.wasm
wasm-opt -O --all-features -o pkg/web_simulator_bg.wasm pkg/web_simulator_bg.wasm
echo '{"name":"@ossm-rs/web-simulator","type":"module","main":"web_simulator.js","types":"web_simulator.d.ts"}' > pkg/package.json
```

1. `cargo build` — the raw module, with the metadata section.
2. `wasm-bindgen --target web` — reads that section, emits
   `web_simulator.js` (glue), `web_simulator.d.ts` (types), and a rewritten
   `web_simulator_bg.wasm`. `--target web` produces an ES module with an
   `init()` default export, for direct `<script type="module">` use.
3. `wasm-opt` (binaryen) — size and speed optimisation.
4. A hand-written `package.json` makes `pkg/` an importable npm package.

The `wasm-bindgen` crate version and the CLI version **must match exactly**,
which is why `Cargo.toml` pins `wasm-bindgen = "=0.2.118"` with an `=`.

## On the JavaScript side

```ts
import init, { Simulator } from "@ossm-rs/web-simulator";
import wasmUrl from "@ossm-rs/web-simulator/web_simulator_bg.wasm?url";

await init({ module_or_path: wasmUrl });
const sim = new Simulator(10.0);
sim.set_depth(0.75);
const pos = sim.get_position();
```

`init` must be awaited before touching anything else — it fetches and
instantiates the module. See
[../22-web-tools-frontend.md](../22-web-tools-frontend.md) for how the React
app memoises that and treats the result as a singleton.
