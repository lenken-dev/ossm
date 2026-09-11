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
fn steady_palette_is_capped_and_idle_is_dimmer() {
    use status_indicator::{
        Rgb,
        policy::{MAX_BRIGHTNESS, color},
    };
    let max = MAX_BRIGHTNESS;
    let orange_green = (u16::from(max) * 80 / 255) as u8;
    let expected = [
        (Status::Idle, Rgb::new(10, 10, 10)),
        (Status::Homing, Rgb::new(max, max, 0)),
        (Status::Stopping, Rgb::new(max, orange_green, 0)),
        (Status::Playing, Rgb::new(0, max, 0)),
        (Status::Paused, Rgb::new(0, 0, max)),
        (Status::Ready, Rgb::new(0, max, 0)),
    ];
    for (status, rgb) in expected {
        assert_eq!(color(status), rgb);
        for channel in [rgb.red, rgb.green, rgb.blue] {
            assert!(channel <= MAX_BRIGHTNESS);
        }
    }
    assert!(color(Status::Idle).red < MAX_BRIGHTNESS);
}

use embassy_futures::block_on;
use status_indicator::{
    ColorIndicator, Indicator, Rgb,
    policy::{Output, color},
};
use std::{cell::Cell, rc::Rc};

#[derive(Default)]
struct Wire {
    visible: Cell<Rgb>,
    fail_on: Cell<bool>,
    fail_color: Cell<bool>,
    writes: Cell<usize>,
}

struct TestIndicator {
    wire: Rc<Wire>,
    remembered: Rgb,
    on: bool,
}

impl Indicator for TestIndicator {
    type Error = ();
    type Panic = TestPanic;

    fn take_panic_indicator(&mut self) -> Option<Self::Panic> {
        None
    }
    async fn set_on(&mut self, on: bool) -> Result<(), ()> {
        self.wire.writes.set(self.wire.writes.get() + 1);
        if self.wire.fail_on.get() {
            return Err(());
        }
        self.on = on;
        self.wire
            .visible
            .set(if on { self.remembered } else { Rgb::BLACK });
        Ok(())
    }
}

struct TestPanic;

impl status_indicator::PanicIndicator for TestPanic {
    type Error = ();

    fn indicate_panic(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

impl ColorIndicator for TestIndicator {
    async fn set_color(&mut self, rgb: Rgb) -> Result<(), ()> {
        if self.on {
            self.wire.writes.set(self.wire.writes.get() + 1);
            if self.wire.fail_color.get() {
                // A failed frame can leave physical output unknown.
                self.wire.visible.set(Rgb::BLACK);
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
        remembered: Rgb::BLACK,
        on: false,
    })
}

#[test]
fn failed_initial_turn_on_retries_and_then_suppresses_unchanged_output() {
    block_on(async {
        let wire = Rc::new(Wire::default());
        let mut output = output(&wire);
        wire.fail_on.set(true);
        assert_eq!(output.apply(Status::Idle).await, Err(()));
        assert_eq!(wire.visible.get(), Rgb::BLACK);
        wire.fail_on.set(false);
        output.apply(Status::Idle).await.unwrap();
        assert_eq!(wire.visible.get(), color(Status::Idle));
        let writes = wire.writes.get();
        output.apply(Status::Idle).await.unwrap();
        assert_eq!(wire.writes.get(), writes);
    });
}

#[test]
fn runtime_failure_retries_latest_color_even_when_returning_to_previous_status() {
    block_on(async {
        let wire = Rc::new(Wire::default());
        let mut output = output(&wire);
        output.apply(Status::Ready).await.unwrap();
        wire.fail_color.set(true);
        assert_eq!(output.apply(Status::Paused).await, Err(()));
        assert_eq!(output.apply(Status::Paused).await, Err(()));
        wire.fail_color.set(false);
        output.apply(Status::Paused).await.unwrap();
        assert_eq!(wire.visible.get(), color(Status::Paused));

        wire.fail_color.set(true);
        assert_eq!(output.apply(Status::Homing).await, Err(()));
        wire.fail_color.set(false);
        output.apply(Status::Paused).await.unwrap();
        assert_eq!(wire.visible.get(), color(Status::Paused));
    });
}

#[test]
fn ready_to_playing_keeps_the_same_steady_output() {
    block_on(async {
        let wire = Rc::new(Wire::default());
        let mut output = output(&wire);
        output.apply(Status::Ready).await.unwrap();
        let writes = wire.writes.get();
        output.apply(Status::Playing).await.unwrap();
        assert_eq!(wire.visible.get(), color(Status::Playing));
        assert_eq!(wire.writes.get(), writes);
    });
}
