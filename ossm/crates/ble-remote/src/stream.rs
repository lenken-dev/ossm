//! Streamed points of one connection, from any of the streaming protocols.
//!
//! Remotes write points as `<position>:<duration ms>` text (see
//! [`payload::parse_duration_point`]).
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
//! Every other player sends each point as
//! its segment starts and never ends a stream, so its points are streamed
//! latest-only (see [`StreamSender::push_latest`]): nothing queued can make
//! the machine run behind or keep moving after the player stopped.
//!
//! A player may instead send timed points, `stream:at:<position>:<time ms>`,
//! due at a time on its own clock, which it stamps with
//! `stream:sync:<time ms>`. The session keeps the offset between the two
//! clocks (see [`ClockOffset`]) and pushes each timed point at its time on
//! the firmware's clock, so a point delayed past it is skipped instead of
//! delaying the rest.

use core::fmt::Write;

use embassy_time::Instant;
use heapless::String;
use log::{info, warn};
use stream_engine::{ClockOffset, PushError, StreamPlanner, StreamSender};

use crate::payload;

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
    /// The firmware's clock minus the player's, for timed points.
    clock: ClockOffset,
    syncs: u32,
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
            clock: ClockOffset::default(),
            syncs: 0,
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
        self.stream_point(data, |stream, data| {
            let point = payload::parse_duration_point(data)?;
            Some(if latest {
                stream.push_latest(point.position, point.duration_ms)
            } else {
                stream.push(point.position, point.duration_ms)
            })
        })
    }

    /// Parse a `stream:at:` timed point and stream it at its time on the
    /// firmware's clock. Invalid before the first sync or when that time
    /// falls before zero. Returns whether it was streamed.
    pub fn push_timed(&mut self, data: &[u8]) -> bool {
        let clock = self.clock;
        self.stream_point(data, |stream, data| {
            let point = payload::parse_timed_point(data)?;
            Some(stream.push_at(point.position, clock.to_local(point.at_ms)?))
        })
    }

    /// Take a `stream:sync:` stamp of the player's clock. Returns whether it
    /// was taken: streaming is available and the stamp is a whole number.
    pub fn sync(&mut self, data: &[u8]) -> bool {
        let now_ms = Instant::now().as_millis();
        if self.stream.is_none() {
            return false;
        }
        let Some(remote_ms) = core::str::from_utf8(data)
            .ok()
            .and_then(|text| text.trim().parse::<u64>().ok())
        else {
            self.invalid_write(data);
            return false;
        };
        self.clock.sync(now_ms, remote_ms);
        self.syncs = self.syncs.saturating_add(1);
        true
    }

    /// Stream a point with `push`, which parses it and returns `None` if it
    /// is invalid. Returns whether it was streamed.
    fn stream_point(
        &mut self,
        data: &[u8],
        push: impl FnOnce(&StreamSender, &[u8]) -> Option<Result<(), PushError>>,
    ) -> bool {
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
        let Some(pushed) = push(stream, data) else {
            self.invalid_write(data);
            return false;
        };
        match pushed {
            Ok(()) => {
                self.points = self.points.saturating_add(1);
                true
            }
            Err(error @ (PushError::QueueFull | PushError::OutOfOrder)) => {
                if count(&mut self.dropped) {
                    warn!(
                        "[stream] point dropped: {error:?} ({} so far)",
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
        let counts = [
            self.points,
            self.invalid,
            self.dropped,
            self.unsupported,
            self.syncs,
        ];
        if counts != [0; 5] {
            info!(
                "[stream] session: {} points streamed, {} invalid writes, {} points dropped, {} points ignored (no streaming), {} syncs (offset {:?} ms)",
                self.points,
                self.invalid,
                self.dropped,
                self.unsupported,
                self.syncs,
                self.clock.offset_ms()
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
