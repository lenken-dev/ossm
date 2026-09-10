#![no_std]

//! Hardware capabilities for status indication, independent of status policy.
//!
//! Primitive indicators implement [`Indicator`]; color-capable indicators also
//! implement [`ColorIndicator`]. This crate has no hardware dependencies.

use core::fmt::Debug;

#[cfg(feature = "policy")]
pub mod policy;

/// Raw, linear RGB channel values. Zero is dark; 255 is full intensity.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rgb {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
}

impl Rgb {
    pub const BLACK: Self = Self::new(0, 0, 0);

    pub const fn new(red: u8, green: u8, blue: u8) -> Self {
        Self { red, green, blue }
    }
}

/// An immediate on/off output, such as a light or an active buzzer.
#[allow(async_fn_in_trait)]
pub trait Indicator {
    type Error: Debug;

    /// Apply the requested output and wait for the hardware update to complete.
    /// Turning off preserves any configured color. No timing pattern is started.
    async fn set_on(&mut self, on: bool) -> Result<(), Self::Error>;
}

/// An indicator that remembers a color independently of its on/off state.
#[allow(async_fn_in_trait)]
pub trait ColorIndicator: Indicator {
    /// Remember a color. If on, also apply it immediately; if off, stay dark.
    /// Black is a valid color, so an indicator that is on may still emit no light.
    async fn set_color(&mut self, color: Rgb) -> Result<(), Self::Error>;
}
