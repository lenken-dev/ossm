//! Streamed points of one connection, from any of the streaming protocols.
//!
//! Both the OSSM-Lite stream characteristic and the `stream:` command write
//! points as `<position>:<duration ms>` text (see [`lite::parse_point`]).
//! The session hands them to the stream engine and counts those it had to
//! ignore, for a summary when the connection ends.
//!
//! A player that finds the stream look-ahead characteristic may send points
//! ahead of time: up to [`LOOKAHEAD`] beyond the point the machine is
//! heading to. A move ends in motion only if its following point is queued
//! when the move starts, so sending them that early leaves room for BLE
//! delays. Such a player ends the stream with `stream:end` whenever its
//! queued points no longer apply (seek, pause, stall, or a change to how it
//! generates points); the next point starts a new stream.

use core::fmt::Write;

use heapless::String;
use log::{info, warn};
use stream_engine::{PushError, StreamSender, lite};

/// Longest point text accepted.
pub const MAX_POINT_LENGTH: usize = 32;

/// Points a player may send beyond the point the machine is heading to.
pub const LOOKAHEAD: u8 = 5;

pub const MAX_LOOKAHEAD_LENGTH: usize = 4;

/// What the stream look-ahead characteristic reads: [`LOOKAHEAD`], or `0`
/// without `streaming`.
pub fn lookahead_text(streaming: bool) -> String<MAX_LOOKAHEAD_LENGTH> {
    let mut text = String::new();
    let lookahead = if streaming { LOOKAHEAD } else { 0 };
    write!(text, "{lookahead}").expect("Always fits");
    text
}

pub struct StreamSession {
    stream: Option<&'static StreamSender>,
    points: u32,
    invalid: u32,
    /// Points this session could not hand to the stream engine.
    dropped: u32,
    /// The stream engine's drop count when the session started.
    engine_dropped_at_start: u32,
    unsupported: u32,
}

impl StreamSession {
    pub fn new(stream: Option<&'static StreamSender>) -> Self {
        Self {
            stream,
            points: 0,
            invalid: 0,
            dropped: 0,
            engine_dropped_at_start: stream.map_or(0, StreamSender::dropped),
            unsupported: 0,
        }
    }

    /// Parse a point and stream it as if received `delay_ms` from now (see
    /// [`StreamSender::push_delayed`]). Returns whether it was streamed.
    pub fn push(&mut self, data: &[u8], delay_ms: u32) -> bool {
        let Some(stream) = self.stream else {
            if count(&mut self.unsupported) {
                warn!(
                    "[stream] streaming unavailable, point ignored ({} so far)",
                    self.unsupported
                );
            }
            return false;
        };
        if data.len() > MAX_POINT_LENGTH {
            self.invalid_write(data);
            return false;
        }
        let Ok(point) = lite::parse_point(data) else {
            self.invalid_write(data);
            return false;
        };
        match stream.push_delayed(point.position, point.duration_ms, delay_ms) {
            Ok(()) => {
                self.points = self.points.saturating_add(1);
                true
            }
            Err(PushError::QueueFull) => {
                if count(&mut self.dropped) {
                    warn!(
                        "[stream] stream queue full, point dropped ({} so far)",
                        self.dropped
                    );
                }
                false
            }
            Err(PushError::InvalidPosition) => {
                self.invalid_write(data);
                false
            }
        }
    }

    /// Count and log a write that could not be parsed.
    pub fn invalid_write(&mut self, data: &[u8]) {
        if count(&mut self.invalid) {
            warn!(
                "[stream] invalid write ignored ({} so far): {:?}",
                self.invalid,
                core::str::from_utf8(data).unwrap_or("<not text>")
            );
        }
    }

    /// Log what this session streamed and ignored.
    ///
    /// Dropped points include those the stream engine dropped further down
    /// (a full planner queue) while the session lasted.
    pub fn log_summary(&self) {
        let dropped = self.stream.map_or(0, |stream| {
            stream.dropped().wrapping_sub(self.engine_dropped_at_start)
        });
        if [self.points, self.invalid, dropped, self.unsupported] != [0; 4] {
            info!(
                "[stream] session: {} points streamed, {} invalid writes, {} points dropped (queue full), {} points ignored (no streaming)",
                self.points, self.invalid, dropped, self.unsupported
            );
        }
    }
}

/// Count an event; true at the first and then at power-of-two counts, to
/// log at a low rate.
fn count(counter: &mut u32) -> bool {
    *counter = counter.saturating_add(1);
    counter.is_power_of_two()
}
