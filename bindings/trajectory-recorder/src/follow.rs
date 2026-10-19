use alloc::boxed::Box;

use ossm::{MotionLimits, Ossm};
use stream_engine::{StreamInput, StreamPlanner, StreamSequencer};
use wasm_bindgen::prelude::*;

use crate::LIMITS;
use crate::stream_recorder::StreamRecorder;

/// Points sent beyond the target, as many as the BLE remote allows.
const LOOKAHEAD: usize = StreamPlanner::CAPACITY - 1;

/// How far from a point the machine may be when it is due, as a share of
/// the stroke length, for the point to count as reached.
const TOLERANCE: f64 = 0.1;

/// Checks how closely the machine follows a script on a machine range of a
/// given length, through the same stream sequencer and motion controller as
/// the firmware.
#[wasm_bindgen]
pub struct FollowCalculator {
    recorder: StreamRecorder,
}

#[wasm_bindgen]
impl FollowCalculator {
    /// A calculator for a machine range `range_mm` long, with the firmware's
    /// other motion limits.
    #[wasm_bindgen(constructor)]
    pub fn new(range_mm: f64) -> Self {
        let limits = MotionLimits {
            max_position_mm: LIMITS.min_position_mm + range_mm.max(1.0),
            ..LIMITS
        };
        // ponytail: leaks one `Ossm` per calculator, as the controller needs
        // it for 'static; fine while calculators are made per range change.
        let (receiver, _observer, motion) = Box::leak(Box::new(Ossm::new())).split();
        Self {
            recorder: StreamRecorder::new(receiver, motion, limits),
        }
    }

    /// The share of the points after the first that the machine reaches
    /// when they are due, streamed with the BLE remote's look-ahead (point
    /// `k` asks for `pos[k]`, 0-100, at `at_ms[k]`, as in
    /// [`TrajectoryRecorder::record_stream`](crate::TrajectoryRecorder::record_stream)).
    pub fn reached(
        &mut self,
        at_ms: &[u32],
        pos: &[f64],
        depth: f64,
        stroke: f64,
        velocity: f64,
        jerk: f64,
    ) -> f64 {
        let count = at_ms.len().min(pos.len());
        if count < 2 {
            return 1.0;
        }
        let input = StreamInput {
            depth,
            stroke,
            velocity,
            jerk,
        }
        .clamped();
        let tick_ms = f64::from(StreamSequencer::TICK_MS);
        let due =
            |k: usize| (f64::from(at_ms[k].saturating_sub(at_ms[0])) / tick_ms).round() as usize;
        let samples = self
            .recorder
            .record(at_ms, pos, input, LOOKAHEAD, due(count - 1) + 1);

        let range = input.stroke_range();
        let tolerance = TOLERANCE * input.depth * input.stroke + 1e-9;
        let reached = (1..count)
            .filter(|&k| {
                samples.get(due(k)).is_some_and(|s| {
                    (s.position - range.stream_to_machine(pos[k])).abs() <= tolerance
                })
            })
            .count();
        reached as f64 / (count - 1) as f64
    }
}
