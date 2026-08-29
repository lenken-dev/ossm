use core::fmt::Debug;

/// A 24-bit colour, one byte per channel. Not a wire format: drivers reorder
/// to whatever their part expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    /// Scale every channel by `factor`.
    ///
    /// Truncates: `scaled(0.5)` of 255 is 127. A `factor` above 1.0 or below
    /// 0.0 saturates, and NaN yields 0 - all three are properties of Rust's
    /// float-to-int cast.
    pub const fn scaled(self, factor: f32) -> Self {
        Self::new(
            (self.r as f32 * factor) as u8,
            (self.g as f32 * factor) as u8,
            (self.b as f32 * factor) as u8,
        )
    }
}

/// A single addressable LED that can be told to show a colour.
///
/// # Failure
///
/// Implementations return `Result` because real hardware can fail (a busy RMT
/// channel, an I2C NAK), but callers are expected to log and carry on:
/// nothing on this trait may stop the machine.
#[allow(async_fn_in_trait)]
pub trait RgbLed {
    type Error: Debug;

    /// Show `color` until told otherwise.
    async fn set_color(&mut self, color: Rgb) -> Result<(), Self::Error>;
}
