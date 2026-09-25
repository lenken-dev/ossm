//! OSSM-Lite compatible streaming service.
//!
//! Lets the OSSM-Lite funscript player stream to this firmware. It writes
//! points to the stream characteristic, and speed and the minimum and
//! maximum depth as percent text. The settings map onto the pattern
//! settings, so every remote shares them (see [`stream_engine::lite`]).

use core::fmt::Write;

use heapless::String;
use log::info;
use pattern_engine::PatternSender;
use stream_engine::{StrokeRange, lite};
use trouble_host::prelude::*;

use crate::Server;
use crate::stream::StreamSession;

pub const SERVICE_UUID: Uuid = uuid!("4f53534d-0000-0000-0000-000000000000");
pub const STREAM_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-53747265616d");
pub const SPEED_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-005370656564");
pub const MAX_DEPTH_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-4d6178446570");
pub const MIN_DEPTH_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-4d696e446570");

pub const MAX_SETTING_LENGTH: usize = 16;

/// What the stream characteristic reads as. The player reads it once to
/// check that the firmware streams.
const STREAM_READY: &str = "Ready";

/// The OSSM-Lite service of one connection.
pub struct LiteSession {
    patterns: &'static PatternSender,
}

impl LiteSession {
    pub fn new(patterns: &'static PatternSender) -> Self {
        Self { patterns }
    }

    /// Refresh the value of a characteristic of this service before a read
    /// is served. Other handles are ignored.
    pub fn on_read(&self, server: &Server<'_>, handle: u16) -> Result<(), Error> {
        let service = &server.lite_service;
        if handle == service.stream.handle {
            let mut ready = String::new();
            ready.push_str(STREAM_READY).expect("Always fits");
            server.set(&service.stream, &ready)?;
        } else if handle == service.speed.handle {
            let speed = self.patterns.input().velocity;
            server.set(&service.speed, &percent_text(speed))?;
        } else if handle == service.max_depth.handle {
            let max = lite::max_depth(stroke_range(self.patterns));
            server.set(&service.max_depth, &percent_text(max))?;
        } else if handle == service.min_depth.handle {
            let min = lite::min_depth(stroke_range(self.patterns));
            server.set(&service.min_depth, &percent_text(min))?;
        }
        Ok(())
    }

    /// Act on a write to a characteristic of this service. Other handles
    /// are ignored.
    pub fn on_write(
        &self,
        server: &Server<'_>,
        session: &mut StreamSession,
        handle: u16,
        data: &[u8],
    ) {
        let service = &server.lite_service;
        if handle == service.stream.handle {
            session.push(data, 0);
        } else if handle == service.speed.handle {
            self.on_setting(session, "speed", data, |patterns, speed| {
                patterns.set_speed(speed)
            });
        } else if handle == service.max_depth.handle {
            self.on_setting(session, "max depth", data, |patterns, max| {
                let range = lite::with_max_depth(stroke_range(patterns), max);
                patterns.set_depth_and_stroke(range.depth, range.stroke);
            });
        } else if handle == service.min_depth.handle {
            self.on_setting(session, "min depth", data, |patterns, min| {
                let range = lite::with_min_depth(stroke_range(patterns), min);
                patterns.set_depth_and_stroke(range.depth, range.stroke);
            });
        }
    }

    fn on_setting(
        &self,
        session: &mut StreamSession,
        name: &str,
        data: &[u8],
        apply: impl FnOnce(&PatternSender, f64),
    ) {
        if data.len() > MAX_SETTING_LENGTH {
            session.invalid_write(data);
            return;
        }
        match lite::parse_setting(data) {
            Ok(value) => {
                info!("[lite] set {} {}", name, lite::setting_percent(value));
                apply(self.patterns, value);
            }
            Err(_) => session.invalid_write(data),
        }
    }
}

fn stroke_range(patterns: &PatternSender) -> StrokeRange {
    let input = patterns.input();
    StrokeRange {
        depth: input.depth,
        stroke: input.stroke,
    }
}

fn percent_text(fraction: f64) -> String<MAX_SETTING_LENGTH> {
    let mut text = String::new();
    write!(text, "{}", lite::setting_percent(fraction)).expect("Always fits");
    text
}
