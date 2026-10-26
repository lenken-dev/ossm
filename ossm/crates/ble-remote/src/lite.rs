//! OSSM-Lite compatible streaming service.
//!
//! Lets the OSSM-Lite funscript player stream to this firmware. It writes
//! points to the stream characteristic, and speed and the minimum and
//! maximum depth as percent text. The settings map onto the pattern
//! settings, so every remote shares them.
//!
//! The player expresses the stroke range as a minimum and a maximum depth,
//! both as percent of the machine range (see [`StrokeRange::min_depth`] and
//! [`StrokeRange::max_depth`]). Changing one keeps the other in place.

use core::fmt::Write;

use heapless::String;
use log::info;
use pattern_engine::PatternSender;
use stream_engine::StrokeRange;
use trouble_host::prelude::*;

use crate::stream::{MAX_POINT_LENGTH, StreamSession};
use crate::{Server, payload};

pub const SERVICE_UUID: Uuid = uuid!("4f53534d-0000-0000-0000-000000000000");
const STREAM_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-53747265616d");
const SPEED_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-005370656564");
const MAX_DEPTH_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-4d6178446570");
const MIN_DEPTH_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-4d696e446570");

const MAX_SETTING_LENGTH: usize = 16;

/// What the stream characteristic reads as. The player reads it once to
/// check that the firmware streams.
const STREAM_READY: &str = "Ready";

/// OSSM-Lite compatible streaming service.
#[gatt_service(uuid = SERVICE_UUID)]
pub struct LiteService {
    #[characteristic(uuid = STREAM_UUID, read, write, write_without_response)]
    stream: String<MAX_POINT_LENGTH>,

    #[characteristic(uuid = SPEED_UUID, read, write)]
    speed: String<MAX_SETTING_LENGTH>,

    #[characteristic(uuid = MAX_DEPTH_UUID, read, write)]
    max_depth: String<MAX_SETTING_LENGTH>,

    #[characteristic(uuid = MIN_DEPTH_UUID, read, write)]
    min_depth: String<MAX_SETTING_LENGTH>,
}

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
            let max = stroke_range(self.patterns).max_depth();
            server.set(&service.max_depth, &percent_text(max))?;
        } else if handle == service.min_depth.handle {
            let min = stroke_range(self.patterns).min_depth();
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
            session.push(data, true);
        } else if handle == service.speed.handle {
            self.on_setting(session, "speed", data, |patterns, speed| {
                patterns.set_speed(speed)
            });
        } else if handle == service.max_depth.handle {
            self.on_setting(session, "max depth", data, |patterns, max| {
                let range = stroke_range(patterns).with_max_depth(max);
                patterns.set_depth_and_stroke(range.depth, range.stroke);
            });
        } else if handle == service.min_depth.handle {
            self.on_setting(session, "min depth", data, |patterns, min| {
                let range = stroke_range(patterns).with_min_depth(min);
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
        match payload::parse_setting(data) {
            Some(value) => {
                info!("[lite] set {} {}", name, payload::setting_percent(value));
                apply(self.patterns, value);
            }
            None => session.invalid_write(data),
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
    write!(text, "{}", payload::setting_percent(fraction)).expect("Always fits");
    text
}
