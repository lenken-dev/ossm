use heapless::Deque;

use crate::StrokeRange;

const CAPACITY: usize = 16;

/// Position differences below this (machine fraction) count as no travel.
const POSITION_EPSILON: f64 = 1e-4;

/// Tuning for [`StreamPlanner`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlannerConfig {
    /// Motion controller tick. A point due within one tick is late.
    pub tick_ms: u32,
    /// Queued points due sooner than this are merged into the following
    /// point when they only continue the current direction of travel.
    pub min_segment_ms: u32,
    /// Minimum time between two move requests, unless the previous request
    /// ends in motion and must be followed immediately.
    pub min_replan_interval_ms: u32,
    /// Maximum speed in machine fraction per second. Limits arrival
    /// velocities and identifies targets that cannot be reached in time.
    /// Non-finite or non-positive values fall back to zero, which disables
    /// both: every move then ends at rest.
    pub max_velocity: f64,
}

impl Default for PlannerConfig {
    fn default() -> Self {
        Self {
            tick_ms: 10,
            min_segment_ms: 50,
            min_replan_interval_ms: 30,
            // 600 mm/s over the default 180 mm machine range.
            max_velocity: 600.0 / 180.0,
        }
    }
}

/// A move for the motion controller to execute.
///
/// Intended to be planned as a single Ruckig move with `position` as target
/// position, `velocity` as target velocity, and the time left until
/// `arrival_ms` as minimum duration.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoveRequest {
    /// Target machine position (0.0–1.0).
    pub position: f64,
    /// Desired arrival time on the planner's clock (ms). Never in the past
    /// at the time the request is issued.
    pub arrival_ms: u64,
    /// Desired velocity at arrival, in machine fraction per second. Positive
    /// values move toward the maximum machine position. Non-zero only when
    /// the following point is already queued.
    pub velocity: f64,
}

impl MoveRequest {
    /// Time left until arrival in seconds, as seen at `now_ms`.
    pub fn duration_secs(&self, now_ms: u64) -> f64 {
        self.arrival_ms.saturating_sub(now_ms) as f64 / 1000.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushError {
    /// The point was not finite.
    InvalidPosition,
    /// The queue is full; the point was dropped, but its duration still
    /// advances the stream timeline.
    QueueFull,
}

/// Counters for diagnostics and evaluation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PlannerStats {
    /// Move requests issued, including refinements of the current move.
    pub moves: u32,
    /// Points skipped because they were late, or unreachable in time on the
    /// way to a later point in the same direction.
    pub skipped: u32,
    /// Short points merged into a following point in the same direction.
    pub collapsed: u32,
    /// Points dropped because the queue was full.
    pub dropped: u32,
}

#[derive(Debug, Clone, Copy)]
struct Point {
    /// Arrival time on the planner's clock (ms).
    at_ms: u64,
    /// Streamed position (0 = deep, 100 = shallow).
    position: f64,
}

#[derive(Debug, Clone, Copy)]
struct Active {
    target: Point,
    /// The move was requested without a following point, so its arrival
    /// velocity may be improved once one arrives.
    awaits_next: bool,
}

#[derive(Debug, Clone, Copy)]
struct LastRequest {
    issued_ms: u64,
    velocity: f64,
}

/// Turns streamed points into move requests.
///
/// Call [`push`](Self::push) for every received point and
/// [`poll`](Self::poll) once per controller tick.
#[derive(Debug)]
pub struct StreamPlanner {
    config: PlannerConfig,
    range: StrokeRange,
    queue: Deque<Point, CAPACITY>,
    /// Arrival time of the most recently pushed point.
    last_at_ms: Option<u64>,
    active: Option<Active>,
    /// Target of the most recent request, kept after it is reached.
    last_target: Option<Point>,
    /// The stroke range changed after the last request.
    range_pending: bool,
    last_request: Option<LastRequest>,
    stats: PlannerStats,
}

impl StreamPlanner {
    /// Number of points the planner can hold ahead of the current move.
    pub const CAPACITY: usize = CAPACITY;

    pub fn new(mut config: PlannerConfig, range: StrokeRange) -> Self {
        if !(config.max_velocity.is_finite() && config.max_velocity > 0.0) {
            config.max_velocity = 0.0;
        }
        Self {
            config,
            range: range.sanitized(),
            queue: Deque::new(),
            last_at_ms: None,
            active: None,
            last_target: None,
            range_pending: false,
            last_request: None,
            stats: PlannerStats::default(),
        }
    }

    pub fn stats(&self) -> PlannerStats {
        self.stats
    }

    /// Change the stroke range (sanitized, see [`StrokeRange::sanitized`]).
    /// The current or last target is re-requested with the new mapping on a
    /// following poll.
    pub fn set_stroke_range(&mut self, range: StrokeRange) {
        let range = range.sanitized();
        if range == self.range {
            return;
        }
        self.range = range;
        self.range_pending = self.last_target.is_some();
    }

    /// Queue a point: reach `position` (0 = deep, 100 = shallow) `duration_ms`
    /// after the previous point.
    ///
    /// The previous point is the later of now and the last queued arrival, so
    /// a client that sends each point as its segment starts and a client that
    /// sends several points ahead both keep their timing without drift.
    pub fn push(&mut self, now_ms: u64, position: f64, duration_ms: u32) -> Result<(), PushError> {
        if !position.is_finite() {
            return Err(PushError::InvalidPosition);
        }
        let start = self.last_at_ms.map_or(now_ms, |last| last.max(now_ms));
        let at_ms = start.saturating_add(u64::from(duration_ms));
        self.last_at_ms = Some(at_ms);

        let point = Point {
            at_ms,
            position: position.clamp(0.0, 100.0),
        };
        self.queue.push_back(point).map_err(|_| {
            self.stats.dropped += 1;
            PushError::QueueFull
        })
    }

    /// Forget all queued points and the current move.
    ///
    /// The caller is responsible for stopping motion, since the last request
    /// may have asked to arrive in motion.
    pub fn clear(&mut self) {
        self.queue.clear();
        self.last_at_ms = None;
        self.active = None;
        self.last_target = None;
        self.range_pending = false;
        self.last_request = None;
    }

    /// Return the next move request, if one is due.
    ///
    /// `machine_position` is the controller's current planned machine
    /// position (0.0–1.0).
    pub fn poll(&mut self, now_ms: u64, machine_position: f64) -> Option<MoveRequest> {
        if let Some(active) = self.active {
            if now_ms < active.target.at_ms {
                return self.refine(now_ms, machine_position, active);
            }
            self.active = None;
        }

        if self.queue.is_empty() {
            return self.correct_range(now_ms, machine_position);
        }

        // A request that ends at rest can wait; one that ends in motion must
        // be followed right away.
        if self
            .last_request
            .is_some_and(|last| last.velocity == 0.0 && self.recently_issued(now_ms))
        {
            return None;
        }

        self.skip_late(now_ms);
        self.skip_passed_through(now_ms, machine_position);

        let target = self.queue.pop_front()?;
        Some(self.request(now_ms, machine_position, target))
    }

    /// Re-request the current move when it can be improved: a following
    /// point arrived after it was requested, or the stroke range changed.
    fn refine(&mut self, now_ms: u64, from: f64, active: Active) -> Option<MoveRequest> {
        let lookahead = active.awaits_next && !self.queue.is_empty();
        if !lookahead && !self.range_pending {
            return None;
        }

        let interval = u64::from(self.config.min_replan_interval_ms);
        if !self.range_pending && active.target.at_ms < now_ms.saturating_add(interval) {
            // Too close to arrival for an optional look-ahead replan.
            if let Some(active) = &mut self.active {
                active.awaits_next = false;
            }
            return None;
        }
        if self.recently_issued(now_ms) {
            return None;
        }

        let request = self.build_request(now_ms, from, active.target);
        if !self.range_pending && request.velocity == 0.0 {
            // The following point reverses direction; the move stays as is.
            if let Some(active) = &mut self.active {
                active.awaits_next = false;
            }
            return None;
        }
        Some(self.issue(now_ms, active.target, request))
    }

    /// With nothing queued, re-request the last target after a stroke range
    /// change so the machine ends up inside the new range.
    fn correct_range(&mut self, now_ms: u64, from: f64) -> Option<MoveRequest> {
        if !self.range_pending || self.recently_issued(now_ms) {
            return None;
        }
        let target = self.last_target?;
        Some(self.request(now_ms, from, target))
    }

    fn recently_issued(&self, now_ms: u64) -> bool {
        let interval = u64::from(self.config.min_replan_interval_ms);
        self.last_request
            .is_some_and(|last| now_ms < last.issued_ms.saturating_add(interval))
    }

    /// Drop points that can no longer be reached on time, keeping the last.
    fn skip_late(&mut self, now_ms: u64) {
        let deadline = now_ms.saturating_add(u64::from(self.config.tick_ms));
        while self.queue.len() > 1 && self.queue.front().is_some_and(|p| p.at_ms <= deadline) {
            self.queue.pop_front();
            self.stats.skipped += 1;
        }
    }

    /// Drop points the machine would only pass through on the way to the
    /// following point: short points (merged) and points that cannot be
    /// reached in time even at maximum speed (skipped). Direction reversals
    /// are kept, so fast zig-zags are cut short rather than flattened.
    fn skip_passed_through(&mut self, now_ms: u64, from: f64) {
        let threshold = now_ms.saturating_add(u64::from(self.config.min_segment_ms));
        while let (Some(&point), Some(&next)) = (self.queue.front(), self.queue.get(1)) {
            let point_pos = self.range.stream_to_machine(point.position);
            let travel_in = point_pos - from;
            let travel_out = self.range.stream_to_machine(next.position) - point_pos;
            let short = point.at_ms < threshold;
            if !short && !self.unreachable(now_ms, travel_in, point.at_ms) {
                break;
            }
            let holds = short && travel_in.abs() < POSITION_EPSILON;
            if !holds && !same_direction(travel_in, travel_out) {
                break;
            }
            self.queue.pop_front();
            if short {
                self.stats.collapsed += 1;
            } else {
                self.stats.skipped += 1;
            }
        }
    }

    /// Whether `travel` takes longer than the time left until `at_ms`, even at
    /// maximum speed.
    fn unreachable(&self, now_ms: u64, travel: f64, at_ms: u64) -> bool {
        let max_velocity = self.config.max_velocity;
        max_velocity > 0.0
            && travel.abs() * 1000.0 / max_velocity > at_ms.saturating_sub(now_ms) as f64
    }

    fn request(&mut self, now_ms: u64, from: f64, target: Point) -> MoveRequest {
        let request = self.build_request(now_ms, from, target);
        self.issue(now_ms, target, request)
    }

    fn issue(&mut self, now_ms: u64, target: Point, request: MoveRequest) -> MoveRequest {
        self.active = Some(Active {
            target,
            awaits_next: self.queue.is_empty(),
        });
        self.last_target = Some(target);
        self.range_pending = false;
        self.last_request = Some(LastRequest {
            issued_ms: now_ms,
            velocity: request.velocity,
        });
        self.stats.moves += 1;
        request
    }

    fn build_request(&self, now_ms: u64, from: f64, target: Point) -> MoveRequest {
        let position = self.range.stream_to_machine(target.position);
        let velocity = self.queue.front().map_or(0.0, |next| {
            self.arrival_velocity(now_ms, from, target, position, next)
        });
        MoveRequest {
            position,
            arrival_ms: target.at_ms.max(now_ms),
            velocity,
        }
    }

    /// Arrival velocity toward `next`: zero unless travel continues in the
    /// same direction, then the slower of the two adjacent average speeds
    /// (which cannot overshoot either segment's pace), limited.
    fn arrival_velocity(
        &self,
        now_ms: u64,
        from: f64,
        target: Point,
        target_pos: f64,
        next: &Point,
    ) -> f64 {
        let travel_in = target_pos - from;
        let travel_out = self.range.stream_to_machine(next.position) - target_pos;
        if !same_direction(travel_in, travel_out) {
            return 0.0;
        }
        let speed_in = average_speed(travel_in, target.at_ms.saturating_sub(now_ms));
        let speed_out = average_speed(travel_out, next.at_ms.saturating_sub(target.at_ms));
        let speed = speed_in.min(speed_out).min(self.config.max_velocity);
        speed.copysign(travel_out)
    }
}

fn same_direction(a: f64, b: f64) -> bool {
    a.abs() >= POSITION_EPSILON && b.abs() >= POSITION_EPSILON && (a > 0.0) == (b > 0.0)
}

/// Unsigned average speed in machine fraction per second; unbounded for
/// segments without time.
fn average_speed(travel: f64, duration_ms: u64) -> f64 {
    if duration_ms == 0 {
        return f64::INFINITY;
    }
    travel.abs() * 1000.0 / duration_ms as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planner() -> StreamPlanner {
        StreamPlanner::new(PlannerConfig::default(), StrokeRange::FULL)
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn maps_shallow_and_deep_ends_like_patterns() {
        let range = StrokeRange {
            depth: 0.8,
            stroke: 0.5,
        };
        assert!(close(range.stream_to_machine(100.0), 0.4));
        assert!(close(range.stream_to_machine(0.0), 0.8));

        let broken = StrokeRange {
            depth: f64::NAN,
            stroke: f64::INFINITY,
        };
        assert_eq!(
            broken.sanitized(),
            StrokeRange {
                depth: 0.0,
                stroke: 0.0
            }
        );
    }

    #[test]
    fn timeline_works_for_players_and_senders_ahead() {
        // Player: each point sent as its segment starts.
        let mut p = planner();
        p.push(1000, 0.0, 300).unwrap();
        assert_eq!(p.poll(1000, 0.0).unwrap().arrival_ms, 1300);
        p.push(1305, 100.0, 200).unwrap(); // sent 5 ms late
        assert_eq!(p.poll(1305, 1.0).unwrap().arrival_ms, 1505);

        // Sender ahead: arrivals accumulate.
        let mut p = planner();
        p.push(0, 0.0, 300).unwrap();
        p.push(0, 100.0, 200).unwrap();
        assert_eq!(p.poll(0, 0.0).unwrap().arrival_ms, 300);
        assert_eq!(p.poll(300, 1.0).unwrap().arrival_ms, 500);
    }

    #[test]
    fn skips_late_points_but_keeps_the_last() {
        let mut p = planner();
        p.push(0, 0.0, 100).unwrap();
        p.push(0, 100.0, 100).unwrap();
        let request = p.poll(150, 0.5).unwrap();
        assert!(close(request.position, 0.0)); // stream 100 = shallow end
        assert_eq!(p.stats().skipped, 1);

        let mut p = planner();
        p.push(0, 100.0, 100).unwrap();
        let request = p.poll(500, 1.0).unwrap();
        assert_eq!(request.arrival_ms, 500);
        assert_eq!(p.stats().skipped, 0);
    }

    #[test]
    fn collapses_short_monotonic_points_but_keeps_reversals() {
        let mut p = planner();
        for pos in [80.0, 60.0, 40.0] {
            p.push(0, pos, 20).unwrap();
        }
        p.push(0, 70.0, 20).unwrap();
        // From the shallow end, 80 and 60 lie on the way to the reversal at 40.
        let request = p.poll(0, 0.0).unwrap();
        assert!(close(request.position, 0.6));
        assert_eq!(request.arrival_ms, 60);
        assert_eq!(request.velocity, 0.0);
        assert_eq!(p.stats().collapsed, 2);
    }

    #[test]
    fn arrival_velocity_follows_lookahead() {
        let mut p = planner();
        p.push(0, 50.0, 500).unwrap(); // 0.5 in 0.5 s from the shallow end
        p.push(0, 0.0, 1000).unwrap(); // 0.5 in 1 s, same direction
        let request = p.poll(0, 0.0).unwrap();
        assert!(close(request.velocity, 0.5));

        let mut p = planner();
        p.push(0, 50.0, 500).unwrap();
        p.push(0, 100.0, 1000).unwrap(); // reversal
        assert_eq!(p.poll(0, 0.0).unwrap().velocity, 0.0);

        let mut p = StreamPlanner::new(
            PlannerConfig {
                max_velocity: f64::NAN,
                ..PlannerConfig::default()
            },
            StrokeRange::FULL,
        );
        p.push(0, 50.0, 500).unwrap();
        p.push(0, 0.0, 1000).unwrap();
        assert_eq!(p.poll(0, 0.0).unwrap().velocity, 0.0);
    }

    #[test]
    fn skips_unreachable_points_only_on_the_way() {
        // Default limit: 1.0 machine fraction takes 300 ms.
        let mut p = planner();
        p.push(0, 50.0, 100).unwrap(); // 0.5 in 100 ms: unreachable
        p.push(0, 0.0, 400).unwrap(); // continues in the same direction
        assert!(close(p.poll(0, 0.0).unwrap().position, 1.0));
        assert_eq!(p.stats().skipped, 1);

        let mut p = planner();
        p.push(0, 50.0, 100).unwrap(); // unreachable reversal point
        p.push(0, 100.0, 400).unwrap();
        assert!(close(p.poll(0, 0.0).unwrap().position, 0.5));
        assert_eq!(p.stats().skipped, 0);
    }

    #[test]
    fn range_changes_are_never_dropped() {
        let deep = StrokeRange {
            depth: 0.5,
            stroke: 1.0,
        };
        // Near arrival: corrected although a look-ahead replan would not be.
        let mut p = planner();
        p.push(0, 0.0, 1000).unwrap();
        p.poll(0, 0.0).unwrap();
        p.set_stroke_range(deep);
        assert!(close(p.poll(990, 0.99).unwrap().position, 0.5));

        // After arrival with nothing queued: the last target is re-requested.
        let mut p = planner();
        p.push(0, 0.0, 100).unwrap();
        p.poll(0, 0.0).unwrap();
        assert!(p.poll(100, 1.0).is_none());
        p.set_stroke_range(deep);
        let request = p.poll(110, 1.0).unwrap();
        assert!(close(request.position, 0.5));
        assert_eq!(request.arrival_ms, 110);
        assert!(p.poll(120, 0.9).is_none());
    }

    #[test]
    fn refines_a_stopping_move_when_travel_continues() {
        let mut p = planner();
        p.push(0, 50.0, 1000).unwrap();
        let first = p.poll(0, 0.0).unwrap();
        assert_eq!(first.velocity, 0.0);
        assert!(p.poll(10, 0.01).is_none());

        p.push(200, 0.0, 1000).unwrap();
        let refined = p.poll(200, 0.1).unwrap();
        assert!(close(refined.position, first.position));
        assert_eq!(refined.arrival_ms, first.arrival_ms);
        assert!(refined.velocity > 0.0);
        assert!(p.poll(210, 0.11).is_none());
    }

    #[test]
    fn keeps_a_stopping_move_before_a_reversal() {
        let mut p = planner();
        p.push(0, 50.0, 1000).unwrap();
        p.poll(0, 0.0).unwrap();
        p.push(200, 100.0, 1000).unwrap();
        assert!(p.poll(200, 0.1).is_none());
        assert_eq!(p.stats().moves, 1);
    }

    #[test]
    fn full_queue_drops_points_but_keeps_timing() {
        let mut p = planner();
        for _ in 0..CAPACITY {
            p.push(0, 0.0, 100).unwrap();
        }
        assert_eq!(p.push(0, 0.0, 100), Err(PushError::QueueFull));
        assert_eq!(p.stats().dropped, 1);
        assert_eq!(p.poll(0, 1.0).unwrap().arrival_ms, 100);
        // The dropped point's duration still counts.
        p.push(0, 0.0, 100).unwrap();
        assert_eq!(p.poll(1790, 1.0).unwrap().arrival_ms, 1800);
    }
}
