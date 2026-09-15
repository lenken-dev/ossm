# Status indication

`status-indicator` provides small synchronous, fallible capabilities:
`Indicator::set_on(bool)` and `ColorIndicator::set_color(RGB8)`. `RGB8` comes
from `smart-leds`; there is no application-specific color or pixel transport
interface. Like the motor, indicators separate portable capabilities from
platform `Config`/`build` adapters and board-level resource allocation.

`SmartLed` adds remembered on/off color and reset/latch delays to a standard
`SmartLedsWrite` writer. Initialization clears the LED while remembering the
initial color. Turning off preserves that color; changing color while off
leaves the LED dark. Turning on displays the remembered color. Black remains a
valid selected color. Logical state changes only after successful writes, and
`set_on` always retransmits so callers can recover from uncertain output.

## ESP hardware and channel ownership

Enable `ossm-esp/indicator-ws2812b` to construct one WS2812B using
`esp-hal-smartled` 0.17.0 and its blocking `SmartLedsAdapter`. The upstream
adapter owns GRB encoding and RMT pulse generation; both normal and panic output
use `SmartLedsWrite::write` and HAL blocking delays. Each write has a 300 µs
low interval before transmission to reset framing and another afterward to
latch the pixel, including when a write returns an error.

Board composition initializes RMT at 80 MHz and passes individual channel
creators to adapters. OSSM Alt assigns channel 0 to normal output, channel 1 to
panic output, and GPIO38 to the LED. The current indicator `Config` expresses
those channel numbers in its types. OSSM Reference similarly passes channel 0
to the step/dir motor adapter, which retains its existing divider and step
pulse configuration. Neither adapter takes the whole RMT peripheral; unused
channels remain available to board composition. This change adds no LED to
OSSM Reference.

The ESP indicator builder returns the normal indicator and an independently
owned panic handle. The panic handle owns the GPIO; normal code owns only its
channel. Both channels start with no pin attached. During initialization, HAL
routing connects normal output to the GPIO. On panic, HAL routing replaces it
with the idle-low panic channel before the reset interval and red frame.
In-flight or later normal writes cannot reconnect the GPIO or overwrite red.
No custom register access, pulse encoder, or panic transport trait is needed.

Firmware registers the panic handle after successful initialization and invokes
it through `esp-backtrace`'s pre-backtrace hook. Atomic one-time acquisition
prevents overlapping mutable access during nested or simultaneous panics.
Panic indication covers either core after registration, uses the shared
brightness level, and remains red until manual reset. It supplements the
existing diagnostics and halt; simultaneous/nested panics do not guarantee
completed physical indication.

The [upstream adapter](https://docs.rs/esp-hal-smartled/0.17.0/esp_hal_smartled/)
panics if channel configuration fails. Its blocking completion polling has no
timeout: stalled RMT hardware can prevent subsequent panic diagnostics. These
upstream behaviors are accepted. Returned initial-clear errors disable indication
with a log message; failed startup turn-on and runtime writes are retried.

## Steady status policy

`status-indicator::policy` exposes state selection, palette, and `Output`.
State selection applies the first matching rule to independent observer snapshots:

| Condition | Status | Color |
| --- | --- | --- |
| Engine Homing | Homing | Yellow |
| Motion Disabled or Enabled | Idle | Dim white |
| Motion Stopping | Stopping | Orange |
| Motion Moving | Playing | Green |
| Engine Playing | Playing | Green |
| Either observer Paused | Paused | Blue |
| Engine Ready | Ready | Green |
| Otherwise | Idle | Dim white |

Engine Playing includes pattern delays and zero-speed holds. Palette values
remain unchanged: green is `(0, 255, 0)`, orange `(255, 80, 0)`, and idle white
`(10, 10, 10)`. The smart LED brightness helper uniformly scales colors using
`MAX_BRIGHTNESS`; no gamma correction is applied. Palette and polling cadence
are defined in `crates/status-indicator/src/policy.rs`.

Firmware displays idle before motor setup. Once observers are available, the
status task polls every 50 ms and performs a blocking update only when the
color changes. A failed write invalidates the applied-color cache and retries
the latest desired output on the next tick. Failure logs are limited to once
every five seconds. Ordinary write errors do not stop motion or pattern execution.

## Firmware integration and verification

The ESP32-S3 firmware always includes WS2812B support because OSSM Alt always
has the indicator. Its board entry point initializes RMT at 80 MHz and passes
channels 0 and 1 plus GPIO38 through `IndicatorConfig`, following the same
resource-config pattern as `MotorConfig`. The shared firmware config uses
`Option<IndicatorConfig>` so Waveshare and Seeed XIAO can pass `None`; no RMT
resources are initialized for them.

The reusable `ossm-esp` platform crate retains its `indicator-ws2812b`
capability feature. Consumers that do not enable that feature exclude
`esp-hal-smartled` and `status-indicator`.

Host behavior checks use the standard smart LED output boundary:

```sh
cargo test -p status-indicator
```

They cover initialization, remembered color, failed writes, observer precedence,
unchanged-color suppression, and retries. GPIO takeover, actual LED timing,
either-core panic injection, and red persistence require hardware observation.
The old simulated custom-panic-transport tests no longer apply.

After sourcing the ESP toolchain environment, compile all ESP32-S3 binaries
from `firmware/esp32s3` with `cargo +esp build --bins --features motor-rs485`.
Build OSSM Reference from `firmware/esp32` with `cargo +esp build --bin
ossm-reference --features motor-stepdir`. Typecheck `ossm-esp` for the desired
chip and motor without `indicator-ws2812b` to verify that the lower-level
hardware dependency remains optional. Optional packages appearing in a lockfile
alone do not imply a build dependency.
