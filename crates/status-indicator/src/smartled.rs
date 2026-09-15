use crate::{ColorIndicator, Indicator};
use embedded_hal::delay::DelayNs;
use smart_leds::{RGB8, SmartLedsWrite, colors};

/// One smart LED with remembered color and synchronous reset/latch delays.
/// The supplied writer owns pixel encoding and hardware transmission.
pub struct SmartLed<W, D> {
    writer: W,
    delay: D,
    color: RGB8,
    on: bool,
}

impl<W, D> Indicator for SmartLed<W, D>
where
    W: SmartLedsWrite,
    W::Color: From<RGB8>,
    W::Error: core::fmt::Debug,
    D: DelayNs,
{
    type Error = W::Error;

    fn set_on(&mut self, on: bool) -> Result<(), Self::Error> {
        self.write(if on { self.color } else { colors::BLACK })?;
        self.on = on;
        Ok(())
    }
}

impl<W, D> ColorIndicator for SmartLed<W, D>
where
    W: SmartLedsWrite,
    W::Color: From<RGB8>,
    W::Error: core::fmt::Debug,
    D: DelayNs,
{
    fn set_color(&mut self, color: RGB8) -> Result<(), Self::Error> {
        if self.on {
            self.write(color)?;
        }
        self.color = color;
        Ok(())
    }
}

impl<W, D> SmartLed<W, D>
where
    W: SmartLedsWrite,
    W::Color: From<RGB8>,
    D: DelayNs,
{
    /// Clear the LED, then retain the initial color without displaying it.
    pub fn new(writer: W, delay: D, color: RGB8) -> Result<Self, W::Error> {
        let mut led = Self {
            writer,
            delay,
            color,
            on: false,
        };
        led.write(colors::BLACK)?;
        Ok(led)
    }

    fn write(&mut self, color: RGB8) -> Result<(), W::Error> {
        // Recover framing after startup, a failed frame, or panic pin takeover.
        // 300 us also covers WS2812B variants requiring >280 us of reset low.
        self.delay.delay_us(300);
        let result = self.writer.write([color]);
        self.delay.delay_us(300);
        result
    }
}
