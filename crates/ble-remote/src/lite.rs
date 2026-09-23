//! OSSM-Lite compatible streaming service.
//!
//! Lets the OSSM-Lite funscript player stream to this firmware. It writes
//! points to the stream characteristic, and speed and the minimum and
//! maximum depth as percent text. The settings map onto the pattern
//! settings, so every remote shares them (see [`stream_engine::lite`]).

use core::fmt::Write;

use heapless::String;
use log::{info, warn};
use pattern_engine::PatternSender;
use stream_engine::{PushError, StreamSender, StrokeRange, lite};
use trouble_host::prelude::*;

use crate::Server;

pub const SERVICE_UUID: Uuid = uuid!("4f53534d-0000-0000-0000-000000000000");
pub const STREAM_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-53747265616d");
pub const SPEED_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-005370656564");
pub const MAX_DEPTH_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-4d6178446570");
pub const MIN_DEPTH_UUID: Uuid = uuid!("4f53534d-436f-6d6d-6f6e-4d696e446570");

pub const MAX_STREAM_LENGTH: usize = 32;
pub const MAX_SETTING_LENGTH: usize = 16;

/// What the stream characteristic reads as. The player reads it once to
/// check that the firmware streams.
const STREAM_READY: &str = "Ready";

/// The OSSM-Lite service of one connection, with counts of the writes it
/// ignored.
pub struct LiteSession {
    patterns: &'static PatternSender,
    stream: Option<&'static StreamSender>,
    points: u32,
    invalid: u32,
    dropped: u32,
    unsupported: u32,
}

impl LiteSession {
    pub fn new(patterns: &'static PatternSender, stream: Option<&'static StreamSender>) -> Self {
        Self {
            patterns,
            stream,
            points: 0,
            invalid: 0,
            dropped: 0,
            unsupported: 0,
        }
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
    pub fn on_write(&mut self, server: &Server<'_>, handle: u16, data: &[u8]) {
        let service = &server.lite_service;
        if handle == service.stream.handle {
            self.on_point(data);
        } else if handle == service.speed.handle {
            self.on_setting("speed", data, |patterns, speed| patterns.set_speed(speed));
        } else if handle == service.max_depth.handle {
            self.on_setting("max depth", data, |patterns, max| {
                let range = lite::with_max_depth(stroke_range(patterns), max);
                patterns.set_depth_and_stroke(range.depth, range.stroke);
            });
        } else if handle == service.min_depth.handle {
            self.on_setting("min depth", data, |patterns, min| {
                let range = lite::with_min_depth(stroke_range(patterns), min);
                patterns.set_depth_and_stroke(range.depth, range.stroke);
            });
        }
    }

    /// Log what this session streamed and ignored.
    pub fn log_summary(&self) {
        if [self.points, self.invalid, self.dropped, self.unsupported] != [0; 4] {
            info!(
                "[lite] session: {} points streamed, {} invalid writes, {} points dropped (queue full), {} points ignored (no streaming)",
                self.points, self.invalid, self.dropped, self.unsupported
            );
        }
    }

    fn on_point(&mut self, data: &[u8]) {
        let Some(stream) = self.stream else {
            if count(&mut self.unsupported) {
                warn!(
                    "[lite] streaming unavailable, point ignored ({} so far)",
                    self.unsupported
                );
            }
            return;
        };
        if data.len() > MAX_STREAM_LENGTH {
            self.invalid_write(data);
            return;
        }
        match lite::parse_point(data) {
            Ok(point) => match stream.push(point.position, point.duration_ms) {
                Ok(()) => self.points = self.points.saturating_add(1),
                Err(PushError::QueueFull) => {
                    if count(&mut self.dropped) {
                        warn!(
                            "[lite] stream queue full, point dropped ({} so far)",
                            self.dropped
                        );
                    }
                }
                Err(PushError::InvalidPosition) => self.invalid_write(data),
            },
            Err(_) => self.invalid_write(data),
        }
    }

    fn on_setting(&mut self, name: &str, data: &[u8], apply: impl FnOnce(&PatternSender, f64)) {
        if data.len() > MAX_SETTING_LENGTH {
            self.invalid_write(data);
            return;
        }
        match lite::parse_setting(data) {
            Ok(value) => {
                info!("[lite] set {} {}", name, lite::setting_percent(value));
                apply(self.patterns, value);
            }
            Err(_) => self.invalid_write(data),
        }
    }

    fn invalid_write(&mut self, data: &[u8]) {
        if count(&mut self.invalid) {
            warn!(
                "[lite] invalid write ignored ({} so far): {:?}",
                self.invalid,
                core::str::from_utf8(data).unwrap_or("<not text>")
            );
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

/// Count an event; true at the first and then at power-of-two counts, to
/// log at a low rate.
fn count(counter: &mut u32) -> bool {
    *counter = counter.saturating_add(1);
    counter.is_power_of_two()
}
