#![no_std]

//! A single WS2812B status indicator with remembered color and on/off control.

use core::fmt::Debug;
use status_indicator::{ColorIndicator, Indicator, Rgb};

/// The hardware boundary for one WS2812B pixel.
#[allow(async_fn_in_trait)]
pub trait PixelWriter {
    type Error: Debug;

    /// Transmit one green/red/blue pixel, MSB first, using WS2812B timing.
    /// Success means the complete frame and reset/latch interval have finished.
    async fn write(&mut self, grb: [u8; 3]) -> Result<(), Self::Error>;
}

/// Controls one LED. The caller supplies its transport and initial on-color.
///
/// Failed or cancelled writes preserve the last successfully requested logical
/// state; the physical output may be unknown. A subsequent `set_on` always writes
/// a complete frame, even if the requested on/off state has not changed.
pub struct Ws2812b<W> {
    writer: W,
    color: Rgb,
    on: bool,
}

impl<W: PixelWriter> Ws2812b<W> {
    /// Clear the physical LED before returning an initially-off indicator.
    pub async fn new(mut writer: W, color: Rgb) -> Result<Self, W::Error> {
        writer.write([0, 0, 0]).await?;
        Ok(Self {
            writer,
            color,
            on: false,
        })
    }

    async fn write_color(&mut self, color: Rgb) -> Result<(), W::Error> {
        self.writer
            .write([color.green, color.red, color.blue])
            .await
    }
}

impl<W: PixelWriter> Indicator for Ws2812b<W> {
    type Error = W::Error;

    async fn set_on(&mut self, on: bool) -> Result<(), Self::Error> {
        let color = if on { self.color } else { Rgb::BLACK };
        self.write_color(color).await?;
        self.on = on;
        Ok(())
    }
}

impl<W: PixelWriter> ColorIndicator for Ws2812b<W> {
    async fn set_color(&mut self, color: Rgb) -> Result<(), Self::Error> {
        if self.on {
            self.write_color(color).await?;
        }
        self.color = color;
        Ok(())
    }
}
