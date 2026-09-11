# Status indicator hardware

`status-indicator` is a `no_std` crate, dependency-free with default features.
`Indicator::set_on(bool)`
provides on/off control, and `ColorIndicator::set_color(Rgb)` adds color support.
Both operations are async and return hardware errors. `Rgb` contains raw 8-bit
red, green, and blue channels; it does not apply gamma or brightness policy.

`ws2812b-indicator` implements these capabilities for one WS2812B through a
`PixelWriter` hardware transport. Initialization clears the LED and remembers
the caller's initial color. Off preserves that color; changing color while off
leaves the output dark. Turning on displays the remembered color, and changing
color while on updates it immediately. Black remains a valid selected color.

The driver commits its logical state only after successful writes. An error or
cancelled write can leave the physical output unknown. Calling `set_on` again
always sends a complete frame, allowing the caller to reapply the desired state.

`Indicator::take_panic_indicator` extracts an independent, synchronous panic
output once. Its bounded attempt overrides normal output and retains the panic
signal until reset. The WS2812B uses continuous red; firmware registers this
output after initialization and invokes it for application panics before
continuing diagnostics and halting.

## ESP support

Enable `ossm-esp/indicator-ws2812b` to use `ossm_esp::indicator::build` with a
`Config` and initial `Rgb`. On ossm-alt, supply GPIO38 as `Config::data` and the
RMT peripheral as `Config::rmt`. The builder configures an async RMT transport
and returns an initially-off indicator. It returns configuration and initial
clear failures to the caller.

The builder owns RMT, using TX channel 0 for normal output and reserving TX
channel 1 for panic output. This follows
the existing ESP peripheral-ownership convention and cannot coexist with the
current step/dir adapter's ownership of the same RMT peripheral. The ossm-alt
RS485 motor does not use RMT. Application composition must account for peripheral ownership.

The transport sends GRB bytes, most significant bit first, with 300 microseconds
low before and after each pixel. The initial reset recovers framing after an
interrupted transmission; the final reset latches the output before the future
completes. Pulse timings follow Worldsemi's
[WS2812B datasheet](https://cdn-shop.adafruit.com/datasheets/WS2812B.pdf) and
[WS2812B-V5 datasheet](https://www.world-semi.co.kr/_files/ugd/89cd03_1023b0e9d135431aa1e6491bfc318112.pdf).
No timer task or heap allocation is needed.

## Build isolation and verification

The ESP32-S3 firmware exposes the same opt-in `indicator-ws2812b` feature. It is
disabled in Cargo defaults, but `ossm-flash` enables it for OSSM Alt, and
`just focus esp32s3` enables it for editor analysis. Its three board executables
share one Cargo package, so features apply to the package, not an individual
executable. Builds without the feature exclude the WS2812B implementation.

From the repository root, run the public-interface behavior checks with
`cargo test -p ws2812b-indicator --test indicator`. They simulate the external
LED transport and exercise clearing, color retention, GRB order, and failures.

From `firmware/esp32s3`, compile the hardware implementation with
`cargo +esp build --lib --features motor-rs485,indicator-ws2812b`. Compare
`cargo tree --edges normal,build --features motor-rs485` with the same command
using `--features motor-rs485,indicator-ws2812b` to check dependency isolation.
Optional packages can appear in `Cargo.lock` without being build dependencies.

Compilation and simulated output checks do not verify physical signal timing or
the board's LED. No hardware observation is implied by those checks.

## Steady status system

The optional `status-indicator/policy` feature provides `select`, `color`, and
`Output`. Engine and motion dependencies are confined to that feature; consumers
of indicator traits do not need it. State selection follows the first matching
rule, including when independently sampled observers disagree:

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

Engine Playing includes pattern delays and zero-speed holds. The palette is
defined by `Rgb` in `crates/status-indicator/src/lib.rs`; polling cadence is
configured in `crates/status-indicator/src/policy.rs`. Normal colors and panic
red share `MAX_BRIGHTNESS`. Normal colors are scaled proportionally when they
exceed that cap; idle uses dim white.

Build ossm-alt with `cargo +esp build --bin ossm-alt --features
motor-rs485,indicator-ws2812b` from `firmware/esp32s3` after sourcing the ESP
toolchain environment. Its board wiring assigns GPIO38 and the RMT peripheral.
The indicator initializes and explicitly turns on with idle before motor setup.
Once both observers are available, a task samples them every 50 ms and applies
changed colors. Initialization failure is logged and disables indication;
failed initial turn-on or runtime output is retried with the latest desired
color on the next task tick. Failed writes invalidate the applied-color cache.
Runtime failure messages are limited to one per five seconds. These failures
do not terminate motion or pattern execution.

The firmware adapter provides the same config/build/start boundary when absent,
initializing no indicator peripherals and spawning no task. Waveshare and
Seeed XIAO use absent configuration even if the package feature is enabled.

Run policy and simulated failure checks with `cargo test -p status-indicator
--features policy --test policy`. Hardware checks remain manual: observe idle
during startup, yellow during homing, green when ready/playing, orange during
deceleration, and blue when paused. Automated checks do not establish physical
LED color, brightness, or timing.
