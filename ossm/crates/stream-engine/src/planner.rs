use heapless::Deque;

use crate::StrokeRange;

const CAPACITY: usize = 16;

/// A point due within this time is late (one controller tick).
const LATE_MS: u64 = 10;

/// Minimum time between re-requests of the last target after stroke range
/// changes, so that dragging a setting does not replan every tick.
const RANGE_RETARGET_MS: u64 = 50;

/// A move for the motion controller to execute.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoveRequest {
    /// Target machine position (0.0–1.0).
    pub position: f64,
    /// Desired arrival time on the planner's clock (ms). Never in the past
    /// at the time the request is issued.
    pub arrival_ms: u64,
    /// Desired velocity at arrival, in machine fraction per second. Positive
    /// values move toward the maximum machine position. Non-zero only when
    /// the following point is already queued and continues the direction of
    /// travel.
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
    /// The queue is full; the point was dropped, but a duration point's
    /// duration still advances the stream timeline.
    QueueFull,
    /// The point was due before the previously queued point.
    OutOfOrder,
}

/// Counters for diagnostics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PlannerStats {
    /// Move requests issued.
    pub moves: u32,
    /// Late points skipped.
    pub skipped: u32,
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

/// Turns streamed points into move requests.
///
/// Call [`push`](Self::push) for every received point and
/// [`poll`](Self::poll) once per controller tick.
#[derive(Debug)]
pub struct StreamPlanner {
    range: StrokeRange,
    queue: Deque<Point, CAPACITY>,
    /// Arrival time of the most recently pushed point.
    last_at_ms: Option<u64>,
    /// Arrival time of the move in progress.
    busy_until_ms: u64,
    /// Streamed position of the last request.
    last_position: Option<f64>,
    /// The stroke range changed after the last request.
    range_changed: bool,
    stats: PlannerStats,
}

impl StreamPlanner {
    /// Number of points the planner can hold ahead of the current move.
    pub const CAPACITY: usize = CAPACITY;

    pub fn new(range: StrokeRange) -> Self {
        Self {
            range: range.sanitized(),
            queue: Deque::new(),
            last_at_ms: None,
            busy_until_ms: 0,
            last_position: None,
            range_changed: false,
            stats: PlannerStats::default(),
        }
    }

    pub fn stats(&self) -> PlannerStats {
        self.stats
    }

    /// Whether nothing is left to request.
    pub fn is_idle(&self) -> bool {
        self.queue.is_empty() && !(self.range_changed && self.last_position.is_some())
    }

    /// Change the stroke range (sanitized). Applies from the next request;
    /// once no point is left, the last target is re-requested in it.
    pub fn set_stroke_range(&mut self, range: StrokeRange) {
        let range = range.sanitized();
        self.range_changed |= range != self.range;
        self.range = range;
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

    /// Queue a point due at `at_ms` on the planner's clock.
    ///
    /// Unlike [`push`](Self::push), its due time does not depend on when it
    /// arrives: a point delayed past it is skipped as late (see
    /// [`poll`](Self::poll)) instead of delaying the points after it. A
    /// dropped point leaves no trace on the timeline.
    pub fn push_at(&mut self, position: f64, at_ms: u64) -> Result<(), PushError> {
        if !position.is_finite() {
            return Err(PushError::InvalidPosition);
        }
        if self.last_at_ms.is_some_and(|last| at_ms < last) {
            return Err(PushError::OutOfOrder);
        }
        let point = Point {
            at_ms,
            position: position.clamp(0.0, 100.0),
        };
        self.queue.push_back(point).map_err(|_| {
            self.stats.dropped += 1;
            PushError::QueueFull
        })?;
        self.last_at_ms = Some(at_ms);
        Ok(())
    }

    /// Make a point the only one: reach `position` `duration_ms` from now,
    /// replacing queued points and the current move.
    pub fn push_latest(
        &mut self,
        now_ms: u64,
        position: f64,
        duration_ms: u32,
    ) -> Result<(), PushError> {
        self.clear();
        self.push(now_ms, position, duration_ms)
    }

    /// Forget all queued points and the current move.
    pub fn clear(&mut self) {
        self.queue.clear();
        self.last_at_ms = None;
        self.busy_until_ms = 0;
        self.last_position = None;
        self.range_changed = false;
    }

    /// Return the next move request once the current one is due.
    ///
    /// Each move is requested once, with the arrival velocity its following
    /// point allows if that point is already queued. A point that arrives
    /// later does not change the move, which then ends at rest.
    ///
    /// `machine_position` is the controller's current planned machine
    /// position (0.0–1.0).
    pub fn poll(&mut self, now_ms: u64, machine_position: f64) -> Option<MoveRequest> {
        if now_ms < self.busy_until_ms {
            return None;
        }
        // Skip points that can no longer be reached on time, keeping the last.
        while self.queue.len() > 1
            && self
                .queue
                .front()
                .is_some_and(|p| p.at_ms <= now_ms + LATE_MS)
        {
            self.queue.pop_front();
            self.stats.skipped += 1;
        }
        let Some(target) = self.queue.pop_front() else {
            return self.retarget(now_ms);
        };
        let position = self.range.stream_to_machine(target.position);
        let arrival_ms = target.at_ms.max(now_ms);
        // Keep moving through the target when the queued next point continues
        // in the same direction, at the mean pace of the two segments.
        let velocity = self.queue.front().map_or(0.0, |next| {
            let travel_in = position - machine_position;
            let travel_out = self.range.stream_to_machine(next.position) - position;
            if travel_in * travel_out <= 0.0 {
                return 0.0;
            }
            let speed = |travel: f64, ms: u64| travel.abs() * 1000.0 / ms.max(1) as f64;
            let speed_in = speed(travel_in, arrival_ms - now_ms);
            let speed_out = speed(travel_out, next.at_ms - arrival_ms);
            ((speed_in + speed_out) / 2.0).copysign(travel_out)
        });
        self.busy_until_ms = target.at_ms;
        self.last_position = Some(target.position);
        self.range_changed = false;
        self.stats.moves += 1;
        Some(MoveRequest {
            position,
            arrival_ms,
            velocity,
        })
    }

    /// Re-request the last target after a stroke range change, so a quiet
    /// stream does not leave the machine outside the new range.
    fn retarget(&mut self, now_ms: u64) -> Option<MoveRequest> {
        let position = self.last_position.filter(|_| self.range_changed)?;
        self.range_changed = false;
        self.busy_until_ms = now_ms + RANGE_RETARGET_MS;
        self.stats.moves += 1;
        Some(MoveRequest {
            position: self.range.stream_to_machine(position),
            arrival_ms: now_ms,
            velocity: 0.0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planner() -> StreamPlanner {
        StreamPlanner::new(StrokeRange::FULL)
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
    fn timed_points_skip_a_stall_instead_of_lagging() {
        let mut p = planner();
        p.push_at(0.0, 1000).unwrap();
        assert_eq!(p.poll(900, 1.0).unwrap().arrival_ms, 1000);
        // A burst received after a stall: the first two are overdue.
        for (i, position) in [100.0, 0.0, 100.0, 0.0].into_iter().enumerate() {
            p.push_at(position, 1200 + 200 * i as u64).unwrap();
        }
        let request = p.poll(1550, 0.0).unwrap();
        assert_eq!(request.arrival_ms, 1600);
        assert!(close(request.position, 0.0)); // stream 100 = shallow end
        assert_eq!(p.stats().skipped, 2);
        assert_eq!(p.poll(1600, 0.0).unwrap().arrival_ms, 1800);
    }

    #[test]
    fn arrival_velocity_follows_lookahead() {
        let mut p = planner();
        p.push(0, 50.0, 500).unwrap(); // 0.5 in 0.5 s from the shallow end
        p.push(0, 0.0, 1000).unwrap(); // 0.5 in 1 s, same direction
        let request = p.poll(0, 0.0).unwrap();
        assert!(close(request.velocity, 0.75));

        let mut p = planner();
        p.push(0, 50.0, 500).unwrap();
        p.push(0, 100.0, 1000).unwrap(); // reversal
        assert_eq!(p.poll(0, 0.0).unwrap().velocity, 0.0);
    }

    #[test]
    fn retargets_after_a_range_change_once_quiet() {
        let deep = StrokeRange {
            depth: 0.5,
            stroke: 1.0,
        };
        let mut p = planner();
        p.push(0, 0.0, 100).unwrap();
        p.poll(0, 0.0).unwrap();
        assert!(p.poll(100, 1.0).is_none());
        p.set_stroke_range(deep);
        assert!(!p.is_idle());
        let request = p.poll(110, 1.0).unwrap();
        assert!(close(request.position, 0.5));
        assert_eq!(request.arrival_ms, 110);
        assert!(p.poll(200, 0.9).is_none());
        assert!(p.is_idle());
    }

    #[test]
    fn never_refines_a_move_for_late_lookahead() {
        let mut p = planner();
        p.push(0, 50.0, 1000).unwrap();
        assert_eq!(p.poll(0, 0.0).unwrap().velocity, 0.0);
        p.push(200, 0.0, 1000).unwrap(); // travel continues
        assert!(p.poll(200, 0.1).is_none());
        assert_eq!(p.stats().moves, 1);
    }

    #[test]
    fn latest_point_replaces_queue_and_current_move() {
        let mut p = planner();
        p.push(0, 0.0, 1000).unwrap();
        p.push(0, 100.0, 1000).unwrap();
        p.poll(0, 0.0).unwrap();
        // Due its duration after reception, not after the queue, and taken
        // up before the current move ends.
        p.push_latest(500, 50.0, 300).unwrap();
        let request = p.poll(500, 0.5).unwrap();
        assert!(close(request.position, 0.5));
        assert_eq!(request.arrival_ms, 800);
        assert!(p.is_idle());
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
