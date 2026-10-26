#![no_std]

//! Streamed motion.
//!
//! A streaming client sends timed points (a position 0-100 and a duration
//! in ms, see [`text`]), or points with an absolute due
//! time ([`StreamSender::push_at`]). [`StreamPlanner`] queues them on
//! its own clock and turns them into [`MoveRequest`]s: a target machine
//! position, an arrival time, and an arrival velocity. Executing a request
//! (as a Ruckig move with a target velocity and a minimum duration) is the
//! motion controller's job.
//!
//! [`StreamSequencer`] is the synchronous glue between the two: it applies
//! the user's [`StreamInput`] to the planner and turns its requests into
//! [`StreamStep`]s (streaming moves and stops), once per controller tick. [`StreamEngine`] wraps
//! it for firmware: [`StreamSender`] feeds points, and [`StreamRunner`]
//! steps the sequencer with the host's settings and drives the motion
//! controller.
//! The runner waits for a stream's first point separately
//! ([`StreamRunner::wait_for_stream`]), so a host can switch into streaming
//! and prepare the machine before running it.
//!
//! The planner and sequencer are synchronous and clock-agnostic: the caller
//! passes the current time in milliseconds to every call.
//!
//! [`text`] parses points and settings as remotes write them. [`ClockOffset`] maps
//! a remote's clock onto the engine's, for points with a due time.

mod clock;
mod engine;
mod input;
mod planner;
mod range;
mod runner;
mod sender;
mod sequencer;
pub mod text;

pub use clock::ClockOffset;
pub use engine::StreamEngine;
pub use input::StreamInput;
pub use planner::{MoveRequest, PlannerStats, PushError, StreamPlanner};
pub use range::StrokeRange;
pub use runner::{ActiveGuard, StreamRunner, StreamStart};
pub use sender::StreamSender;
pub use sequencer::{StreamSequencer, StreamStep};
