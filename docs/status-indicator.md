# Status indicator hardware

`status-indicator` is a dependency-free `no_std` crate. `Indicator::set_on(bool)`
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

## ESP support

Enable `ossm-esp/indicator-ws2812b` to use `ossm_esp::indicator::build` with a
`Config` and initial `Rgb`. On ossm-alt, supply GPIO38 as `Config::data` and the
RMT peripheral as `Config::rmt`. The builder configures an async RMT transport
and returns an initially-off indicator. It returns configuration and initial
clear failures to the caller.

The builder owns RMT and uses TX channel 0 with an 80 MHz clock. This follows
the existing ESP peripheral-ownership convention and cannot coexist with the
current step/dir adapter's ownership of the same RMT peripheral. The ossm-alt
RS485 motor does not use RMT. Future application composition must account for
peripheral ownership; this change does not alter motor adapters.

The transport sends GRB bytes, most significant bit first, with 300 microseconds
low before and after each pixel. The initial reset recovers framing after an
interrupted transmission; the final reset latches the output before the future
completes. Pulse timings follow Worldsemi's
[WS2812B datasheet](https://cdn-shop.adafruit.com/datasheets/WS2812B.pdf) and
[WS2812B-V5 datasheet](https://www.world-semi.co.kr/_files/ugd/89cd03_1023b0e9d135431aa1e6491bfc318112.pdf).
No timer task or heap allocation is needed.

## Build isolation and verification

The ESP32-S3 firmware exposes the same opt-in `indicator-ws2812b` feature. It is
disabled by default. Its three board executables share one Cargo package, so
features apply to the package, not an individual executable. Normal board builds
do not pull in the WS2812B implementation. Explicitly enabling the feature opts
that build into the driver, regardless of the executable selected.

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

Status policy, timed patterns, primitive LED/buzzer drivers, application
integration, and a standalone example are outside this change.
