//! Latency compensation, as the official OSSM funscript player uses it.
//!
//! The player sends each `stream:` point a buffer time ahead of its
//! funscript action and enables latency compensation; the firmware then
//! delays the point by that buffer. The time gained lets the next point
//! arrive while the previous move is still under way, so moves can end in
//! motion, and hides BLE transmission delay.
//!
//! The buffer is set with `set:buffer:<value>`, where the value is half the
//! buffer in milliseconds (0-100, so up to 200 ms), and is reported the same
//! way in the state. The player sends half of its whole-millisecond slider,
//! so the value may have a fractional half. Both settings last for one
//! connection.

use core::cell::Cell;

use heapless::String;

pub const MAX_CONFIG_LENGTH: usize = 32;

/// Buffer in milliseconds until the client sets one, as in the official
/// firmware.
const DEFAULT_BUFFER_MS: u16 = 200;
const MAX_BUFFER_MS: u16 = 200;

/// What the latency compensation characteristic reads as after an invalid
/// write.
const INVALID: &str = "error:invalid_value";

pub struct LatencyCompensation {
    enabled: Cell<bool>,
    buffer_ms: Cell<u16>,
}

impl LatencyCompensation {
    pub fn new() -> Self {
        Self {
            enabled: Cell::new(false),
            buffer_ms: Cell::new(DEFAULT_BUFFER_MS),
        }
    }

    /// Delay for streamed points: the buffer while compensating, else none.
    pub fn delay_ms(&self) -> u32 {
        if self.enabled.get() {
            u32::from(self.buffer_ms.get())
        } else {
            0
        }
    }

    /// The buffer as reported in the state: half of it in milliseconds.
    pub fn buffer_value(&self) -> f64 {
        f64::from(self.buffer_ms.get()) / 2.0
    }

    /// Set the buffer from a `set:buffer` value. Returns false, keeping the
    /// buffer, unless the value is a number; it is clamped to 0-100.
    pub fn set_buffer(&self, value: &str) -> bool {
        match value.parse::<f64>() {
            Ok(value) if value.is_finite() => {
                // Rounds to nearest; `f64::round` needs std.
                let ms = (value * 2.0).clamp(0.0, f64::from(MAX_BUFFER_MS)) + 0.5;
                self.buffer_ms.set(ms as u16);
                true
            }
            _ => false,
        }
    }

    /// Enable or disable compensation from a characteristic write:
    /// `true`/`1`/`t` or `false`/`0`/`f`, ignoring case. Returns the value
    /// the characteristic reads as afterwards.
    pub fn on_write(&self, data: &[u8]) -> String<MAX_CONFIG_LENGTH> {
        let text = core::str::from_utf8(data).unwrap_or("");
        let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\0');
        let enabled = ["true", "1", "t"]
            .iter()
            .any(|value| text.eq_ignore_ascii_case(value));
        let disabled = ["false", "0", "f"]
            .iter()
            .any(|value| text.eq_ignore_ascii_case(value));
        if enabled || disabled {
            self.enabled.set(enabled);
            self.text()
        } else {
            let mut invalid = String::new();
            invalid.push_str(INVALID).expect("Always fits");
            invalid
        }
    }

    /// Whether compensation is enabled, as the characteristic reads.
    pub fn text(&self) -> String<MAX_CONFIG_LENGTH> {
        let mut text = String::new();
        text.push_str(if self.enabled.get() { "true" } else { "false" })
            .expect("Always fits");
        text
    }
}
