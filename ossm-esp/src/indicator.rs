//! Blocking smart LED support with independent normal and panic channels.
//! Board composition initializes RMT at 80 MHz and allocates the channels.

use esp_hal::{
    Blocking,
    delay::Delay,
    gpio::{AnyPin, Level, NoPin, Output, OutputConfig, OutputSignal},
    rmt::{ChannelCreator, PulseCode},
};
use esp_hal_smartled::{LedAdapterError, SmartLedsAdapter, buffer_size, smart_led_buffer};
use static_cell::StaticCell;
use status_indicator::{Indicator as _, PANIC_COLOR, RGB8, SmartLed};

pub struct Config<'d> {
    pub channel: ChannelCreator<'d, Blocking, 0>,
    pub panic_channel: ChannelCreator<'d, Blocking, 1>,
    pub data: AnyPin<'d>,
}

pub type Indicator = SmartLed<SmartLedsAdapter<'static, { buffer_size(1) }>, Delay>;

/// Independent panic output, registered by firmware after initialization.
/// It uses upstream blocking completion, which has no timeout.
pub struct PanicIndicator {
    indicator: Indicator,
    data: Output<'static>,
}

impl PanicIndicator {
    pub fn indicate_panic(&mut self) -> Result<(), LedAdapterError> {
        // The panic channel is idle low. Take over the pin before resetting
        // framing; normal writes cannot reconnect it or replace panic red.
        OutputSignal::RMT_SIG_1.connect_to(&self.data);
        self.indicator.set_on(true)
    }
}

/// Clear the LED and construct separately owned normal and panic outputs.
/// Channel-configuration failures follow the upstream constructor's panic
/// behavior; returned clear/write errors remain recoverable by the caller.
pub fn build(
    config: Config<'static>,
    color: RGB8,
) -> Result<(Indicator, PanicIndicator), LedAdapterError> {
    static NORMAL_BUFFER: StaticCell<[PulseCode; buffer_size(1)]> = StaticCell::new();
    static PANIC_BUFFER: StaticCell<[PulseCode; buffer_size(1)]> = StaticCell::new();

    // Configure both adapters without a pin so the panic handle can retain
    // exclusive GPIO ownership. Normal code owns only its RMT channel.
    let normal = SmartLedsAdapter::new(
        config.channel,
        NoPin,
        NORMAL_BUFFER.init(smart_led_buffer!(1)),
    );
    let panic = SmartLedsAdapter::new(
        config.panic_channel,
        NoPin,
        PANIC_BUFFER.init(smart_led_buffer!(1)),
    );
    let panic = SmartLed::new(panic, Delay::new(), PANIC_COLOR)?;
    let data = Output::new(config.data, Level::Low, OutputConfig::default());
    OutputSignal::RMT_SIG_0.connect_to(&data);
    let normal = SmartLed::new(normal, Delay::new(), color)?;
    Ok((
        normal,
        PanicIndicator {
            indicator: panic,
            data,
        },
    ))
}
