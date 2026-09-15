use ossm::MotionPhase;
use pattern_engine::EngineState;
use status_indicator::policy::{Status, select};

#[test]
fn all_observer_combinations_follow_status_precedence() {
    use Status::*;
    let phases = [
        MotionPhase::Disabled,
        MotionPhase::Enabled,
        MotionPhase::Ready,
        MotionPhase::Moving,
        MotionPhase::Stopping,
        MotionPhase::Paused,
    ];
    // Columns follow phases above; literals come from the spec's priority table.
    let cases = [
        (
            EngineState::Idle,
            [Idle, Idle, Idle, Playing, Stopping, Paused],
        ),
        (EngineState::Homing, [Homing; 6]),
        (
            EngineState::Ready,
            [Idle, Idle, Ready, Playing, Stopping, Paused],
        ),
        (
            EngineState::Playing(3),
            [Idle, Idle, Playing, Playing, Stopping, Playing],
        ),
        (
            EngineState::Paused(3),
            [Idle, Idle, Paused, Playing, Stopping, Paused],
        ),
    ];
    for (engine, expected) in cases {
        for (motion, status) in phases.into_iter().zip(expected) {
            assert_eq!(select(engine, motion), status, "{engine:?}, {motion:?}");
        }
    }
}

#[test]
fn steady_palette_preserves_the_status_colors() {
    use status_indicator::{RGB8, policy::color};
    let expected = [
        (Status::Idle, RGB8::new(10, 10, 10)),
        (Status::Homing, RGB8::new(255, 255, 0)),
        (Status::Stopping, RGB8::new(255, 80, 0)),
        (Status::Playing, RGB8::new(0, 255, 0)),
        (Status::Paused, RGB8::new(0, 0, 255)),
        (Status::Ready, RGB8::new(0, 255, 0)),
    ];
    for (status, rgb) in expected {
        assert_eq!(color(status), rgb);
    }
}

use status_indicator::{
    ColorIndicator, Indicator, RGB8,
    policy::{Output, color},
};
use std::{cell::Cell, rc::Rc};

#[derive(Default)]
struct Wire {
    visible: Cell<RGB8>,
    fail_on: Cell<bool>,
    fail_color: Cell<bool>,
    writes: Cell<usize>,
}

struct TestIndicator {
    wire: Rc<Wire>,
    remembered: RGB8,
    on: bool,
}

impl Indicator for TestIndicator {
    type Error = ();
    fn set_on(&mut self, on: bool) -> Result<(), ()> {
        self.wire.writes.set(self.wire.writes.get() + 1);
        if self.wire.fail_on.get() {
            return Err(());
        }
        self.on = on;
        self.wire.visible.set(if on {
            self.remembered
        } else {
            smart_leds::colors::BLACK
        });
        Ok(())
    }
}

impl ColorIndicator for TestIndicator {
    fn set_color(&mut self, rgb: RGB8) -> Result<(), ()> {
        if self.on {
            self.wire.writes.set(self.wire.writes.get() + 1);
            if self.wire.fail_color.get() {
                // A failed frame can leave physical output unknown.
                self.wire.visible.set(smart_leds::colors::BLACK);
                return Err(());
            }
            self.wire.visible.set(rgb);
        }
        self.remembered = rgb;
        Ok(())
    }
}

fn output(wire: &Rc<Wire>) -> Output<TestIndicator> {
    Output::new(TestIndicator {
        wire: wire.clone(),
        remembered: smart_leds::colors::BLACK,
        on: false,
    })
}

#[test]
fn failed_initial_turn_on_retries_and_then_suppresses_unchanged_output() {
    let wire = Rc::new(Wire::default());
    let mut output = output(&wire);
    wire.fail_on.set(true);
    assert_eq!(output.apply(Status::Idle), Err(()));
    assert_eq!(wire.visible.get(), smart_leds::colors::BLACK);
    wire.fail_on.set(false);
    output.apply(Status::Idle).unwrap();
    assert_eq!(wire.visible.get(), color(Status::Idle));
    let writes = wire.writes.get();
    output.apply(Status::Idle).unwrap();
    assert_eq!(wire.writes.get(), writes);
}

#[test]
fn runtime_failure_retries_latest_color_even_when_returning_to_previous_status() {
    let wire = Rc::new(Wire::default());
    let mut output = output(&wire);
    output.apply(Status::Ready).unwrap();
    wire.fail_color.set(true);
    assert_eq!(output.apply(Status::Paused), Err(()));
    assert_eq!(output.apply(Status::Paused), Err(()));
    wire.fail_color.set(false);
    output.apply(Status::Paused).unwrap();
    assert_eq!(wire.visible.get(), color(Status::Paused));

    wire.fail_color.set(true);
    assert_eq!(output.apply(Status::Homing), Err(()));
    wire.fail_color.set(false);
    output.apply(Status::Paused).unwrap();
    assert_eq!(wire.visible.get(), color(Status::Paused));
}

#[test]
fn ready_to_playing_keeps_the_same_steady_output() {
    let wire = Rc::new(Wire::default());
    let mut output = output(&wire);
    output.apply(Status::Ready).unwrap();
    let writes = wire.writes.get();
    output.apply(Status::Playing).unwrap();
    assert_eq!(wire.visible.get(), color(Status::Playing));
    assert_eq!(wire.writes.get(), writes);
}
