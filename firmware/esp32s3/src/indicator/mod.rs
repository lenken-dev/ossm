mod ws2812b;

pub type Config = ossm_esp::indicator::Config<'static>;
pub use ws2812b::{build, start};
