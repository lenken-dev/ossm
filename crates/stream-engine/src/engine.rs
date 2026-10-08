use core::sync::atomic::AtomicU8;

use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;

use crate::StreamPlanner;
use crate::runner::StreamRunner;
use crate::sender::StreamSender;

/// A streamed point, stamped with its reception time.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Point {
    pub(crate) received_ms: u64,
    pub(crate) position: f64,
    pub(crate) duration_ms: u32,
    /// Replaces queued points (see
    /// [`StreamPlanner::push_latest`](crate::StreamPlanner::push_latest)).
    pub(crate) latest: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum EngineCommand {
    Point(Point),
    Stop,
}

/// Holds as many points as the planner queue, since the runner drains it
/// every tick.
pub(crate) type EngineCommandChannel =
    Channel<CriticalSectionRawMutex, EngineCommand, { StreamPlanner::CAPACITY }>;

/// Root container for a stream engine.
///
/// Carries the command channel and activity count
/// that the capability handles project from. `StreamEngine` is instantiated
/// once in static storage and immediately consumed by [`split`](Self::split).
pub struct StreamEngine {
    pub(crate) commands: EngineCommandChannel,
    /// Live [`ActiveGuard`](crate::ActiveGuard)s; streaming is active while
    /// any exist.
    pub(crate) active: AtomicU8,
}

impl StreamEngine {
    pub const fn new() -> Self {
        Self {
            commands: EngineCommandChannel::new(),
            active: AtomicU8::new(0),
        }
    }

    /// Split into the stream-engine capabilities.
    ///
    /// Consumes a unique `&'static mut Self`, so it can be called at most
    /// once. The expected boot shape is
    /// `StaticCell::init(StreamEngine::new()).split()`.
    ///
    /// - [`StreamRunner`] is the driver capability, consumed by
    ///   [`run`](StreamRunner::run) to start the engine loop.
    /// - [`StreamSender`] pushes points and stops the stream.
    pub fn split(&'static mut self) -> (StreamRunner, StreamSender) {
        (StreamRunner::new(self), StreamSender::new(self))
    }
}

impl Default for StreamEngine {
    fn default() -> Self {
        Self::new()
    }
}
