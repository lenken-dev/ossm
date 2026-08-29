//! WS2812B driver over the RMT peripheral.
//!
//! WS2812s carry no clock: a bit is a fixed-period pulse whose *duty cycle*
//! encodes its value, to a ±150 ns tolerance. RMT clocks the frame out in
//! hardware, so holding that timing does not depend on the CPU.

use core::fmt::{self, Debug};

use esp_hal::{
    Async,
    gpio::{AnyPin, Level},
    peripherals::RMT,
    rmt::{Channel, PulseCode, Rmt, Tx, TxChannelConfig, TxChannelCreator},
    time::Rate,
};
use ossm::{Rgb, RgbLed};

/// RMT base clock. With `clk_divider = 1` this yields 12.5 ns per tick.
const RMT_CLK_FREQ_MHZ: u32 = 80;
const RMT_CLK_DIVIDER: u8 = 1;

/// WS2812B bit timings, in 12.5 ns RMT ticks. A `0` bit is a short high then
/// a long low; a `1` bit is the reverse, both over a ~1.25 µs period.
const T0H_TICKS: u16 = 32; // 400 ns
const T0L_TICKS: u16 = 68; // 850 ns
const T1H_TICKS: u16 = 64; // 800 ns
const T1L_TICKS: u16 = 36; // 450 ns

/// Latch gap held low after the frame, sent as both halves of one pulse code.
/// The datasheet wants >50 µs of idle before the LED commits the colour.
const RESET_HALF_TICKS: u16 = 4000; // 50 µs, sent twice

const BITS_PER_LED: usize = 24;
/// 24 bits, one reset code, one end marker — inside the 48-word RMT memory
/// block a single channel owns.
const PULSE_BUF_LEN: usize = BITS_PER_LED + 2;

pub struct Config {
    pub rmt: RMT<'static>,
    pub pin: AnyPin<'static>,
}

pub enum Ws2812Error {
    Rmt(esp_hal::rmt::Error),
}

impl Debug for Ws2812Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rmt(e) => write!(f, "Rmt({:?})", e),
        }
    }
}

/// Build the driver, or return `None` if the RMT peripheral will not come up.
/// Never panics: a dark LED must not stop an otherwise working machine.
pub fn build(config: Config) -> Option<Ws2812> {
    let rmt = match Rmt::new(config.rmt, Rate::from_mhz(RMT_CLK_FREQ_MHZ)) {
        Ok(rmt) => rmt.into_async(),
        Err(e) => {
            log::warn!("LED disabled: failed to initialize RMT: {:?}", e);
            return None;
        }
    };

    // The LED reads a long low line as the latch, so the line must rest low.
    let tx_config = TxChannelConfig::default()
        .with_clk_divider(RMT_CLK_DIVIDER)
        .with_idle_output(true)
        .with_idle_output_level(Level::Low);

    match rmt.channel0.configure_tx(config.pin, tx_config) {
        Ok(channel) => Some(Ws2812 { channel }),
        Err(e) => {
            log::warn!("LED disabled: failed to configure RMT TX channel: {:?}", e);
            None
        }
    }
}

/// A single WS2812B addressable LED.
pub struct Ws2812 {
    channel: Channel<'static, Async, Tx>,
}

impl RgbLed for Ws2812 {
    type Error = Ws2812Error;

    async fn set_color(&mut self, color: Rgb) -> Result<(), Self::Error> {
        let one = PulseCode::new(Level::High, T1H_TICKS, Level::Low, T1L_TICKS);
        let zero = PulseCode::new(Level::High, T0H_TICKS, Level::Low, T0L_TICKS);
        let reset = PulseCode::new(Level::Low, RESET_HALF_TICKS, Level::Low, RESET_HALF_TICKS);

        let mut buf = [PulseCode::end_marker(); PULSE_BUF_LEN];
        let mut i = 0;

        // GRB on the wire, most significant bit first.
        for byte in [color.g, color.r, color.b] {
            for bit in (0..8).rev() {
                buf[i] = if (byte >> bit) & 1 == 1 { one } else { zero };
                i += 1;
            }
        }

        buf[i] = reset;
        buf[i + 1] = PulseCode::end_marker();

        self.channel
            .transmit(&buf)
            .await
            .map_err(Ws2812Error::Rmt)
    }
}
