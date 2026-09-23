#![no_std]

//! Planning strategy for streamed motion.
//!
//! A streaming client sends timed points (`<position 0-100>:<duration ms>`,
//! as the OSSM-Lite funscript player does). [`StreamPlanner`] queues them on
//! its own clock and turns them into [`MoveRequest`]s: a target machine
//! position, an arrival time, and an arrival velocity. Executing a request
//! (as a Ruckig move with a target velocity and a minimum duration) is the
//! motion controller's job.
//!
//! The planner is synchronous and clock-agnostic: the caller passes the
//! current time in milliseconds to every call.

mod planner;
mod range;

pub use planner::{MoveRequest, PlannerConfig, PlannerStats, PushError, StreamPlanner};
pub use range::StrokeRange;
