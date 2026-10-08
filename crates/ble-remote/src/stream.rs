//! Streamed points of one connection, from any of the streaming protocols.
//!
//! Both the OSSM-Lite stream characteristic and the `stream:` command write
//! points as `<position>:<duration ms>` text (see [`lite::parse_point`]).
//! The session hands them to the stream engine and counts those it had to
//! ignore, for a summary when the connection ends.
//!
//! A player that reads the stream look-ahead characteristic may send points
//! ahead of time: up to [`LOOKAHEAD`] beyond the point the machine is
//! heading to. A move ends in motion only if its following point is queued
//! when the move starts, so sending them that early leaves room for BLE
//! delays. Such a player ends the stream with `stream:end` whenever its
//! queued points no longer apply (seek, pause, stall, or a change to how it
//! generates points); the next point starts a new stream.
//!
//! Every other player (OSSM-Lite, the official OSSM one) sends each point as
//! its segment starts and never ends a stream, so its points are streamed
//! latest-only (see [`StreamSender::push_latest`]): nothing queued can make
//! the machine run behind or keep moving after the player stopped.

use core::fmt::Write;

use heapless::String;
use log::{info, warn};
use stream_engine::{PushError, StreamPlanner, StreamSender, lite};

/// Longest point text accepted.
pub const MAX_POINT_LENGTH: usize = 32;

/// Points a player may send beyond the point the machine is heading to: the
/// planner queue, less the next target, which stays queued until the
/// current move ends.
pub const LOOKAHEAD: usize = StreamPlanner::CAPACITY - 1;

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
    unsupported: u32,
    /// The player read the look-ahead, so it may send points ahead.
    sends_ahead: bool,
}

impl StreamSession {
    pub fn new(stream: Option<&'static StreamSender>) -> Self {
        Self {
            stream,
            points: 0,
            invalid: 0,
            dropped: 0,
            unsupported: 0,
            sends_ahead: false,
        }
    }

    /// The player read the look-ahead: queue its `stream:` points from now
    /// on instead of streaming them latest-only.
    pub fn allow_lookahead(&mut self) {
        self.sends_ahead = true;
    }

    /// Parse and stream a `stream:` command point: queued if the player may
    /// send ahead, else latest-only. Returns whether it was streamed.
    pub fn push_command(&mut self, data: &[u8]) -> bool {
        self.push(data, !self.sends_ahead)
    }

    /// Parse a point and stream it, latest-only if `latest` (see
    /// [`StreamSender::push_latest`]). Returns whether it was streamed.
    pub fn push(&mut self, data: &[u8], latest: bool) -> bool {
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
        let pushed = if latest {
            stream.push_latest(point.position, point.duration_ms)
        } else {
            stream.push(point.position, point.duration_ms)
        };
        match pushed {
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
    /// Dropped points are those the command queue refused; the stream
    /// engine logs its own planner-queue drops.
    pub fn log_summary(&self) {
        if [self.points, self.invalid, self.dropped, self.unsupported] != [0; 4] {
            info!(
                "[stream] session: {} points streamed, {} invalid writes, {} points dropped (queue full), {} points ignored (no streaming)",
                self.points, self.invalid, self.dropped, self.unsupported
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
