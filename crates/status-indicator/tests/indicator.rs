use std::{cell::Cell, rc::Rc};

use embedded_hal::delay::DelayNs;
use smart_leds::{RGB8, SmartLedsWrite, colors};
use status_indicator::{ColorIndicator, Indicator, SmartLed};

#[derive(Default)]
struct Wire {
    visible: Cell<RGB8>,
    fail: Cell<bool>,
}

struct LedWire(Rc<Wire>);

impl SmartLedsWrite for LedWire {
    type Color = RGB8;
    type Error = ();

    fn write<T, I>(&mut self, pixels: T) -> Result<(), Self::Error>
    where
        T: IntoIterator<Item = I>,
        I: Into<Self::Color>,
    {
        if self.0.fail.get() {
            return Err(());
        }
        self.0
            .visible
            .set(pixels.into_iter().next().unwrap().into());
        Ok(())
    }
}

struct NoDelay;

impl DelayNs for NoDelay {
    fn delay_ns(&mut self, _: u32) {}
}

#[test]
fn initialization_clears_an_already_lit_led() {
    let wire = Rc::new(Wire::default());
    wire.visible.set(colors::BLUE);
    let _indicator = SmartLed::new(LedWire(wire.clone()), NoDelay, colors::RED).unwrap();
    assert_eq!(wire.visible.get(), colors::BLACK);
}

#[test]
fn on_off_and_color_changes_preserve_the_selected_color() {
    let wire = Rc::new(Wire::default());
    let mut indicator = SmartLed::new(LedWire(wire.clone()), NoDelay, colors::RED).unwrap();
    indicator.set_on(true).unwrap();
    assert_eq!(wire.visible.get(), colors::RED);
    indicator.set_on(false).unwrap();
    indicator.set_color(colors::BLUE).unwrap();
    assert_eq!(wire.visible.get(), colors::BLACK);
    indicator.set_on(true).unwrap();
    assert_eq!(wire.visible.get(), colors::BLUE);
    indicator.set_color(RGB8::new(30, 40, 50)).unwrap();
    assert_eq!(wire.visible.get(), RGB8::new(30, 40, 50));
}

#[test]
fn initialization_reports_a_failed_clear() {
    let wire = Rc::new(Wire::default());
    wire.fail.set(true);
    assert!(matches!(
        SmartLed::new(LedWire(wire), NoDelay, colors::RED),
        Err(())
    ));
}

#[test]
fn failed_updates_preserve_logical_state_and_can_be_retried() {
    let wire = Rc::new(Wire::default());
    let mut indicator = SmartLed::new(LedWire(wire.clone()), NoDelay, colors::RED).unwrap();
    wire.fail.set(true);
    assert_eq!(indicator.set_on(true), Err(()));
    indicator.set_color(colors::BLUE).unwrap();
    wire.fail.set(false);
    indicator.set_on(true).unwrap();
    assert_eq!(wire.visible.get(), colors::BLUE);

    wire.fail.set(true);
    assert_eq!(indicator.set_color(colors::RED), Err(()));
    assert_eq!(indicator.set_on(false), Err(()));
    assert_eq!(indicator.set_color(colors::LIME), Err(()));
    wire.fail.set(false);
    indicator.set_on(false).unwrap();
    assert_eq!(wire.visible.get(), colors::BLACK);
    indicator.set_on(true).unwrap();
    assert_eq!(wire.visible.get(), colors::BLUE);
    // A repeated on request restores output even after an external disturbance.
    wire.visible.set(colors::BLACK);
    indicator.set_on(true).unwrap();
    assert_eq!(wire.visible.get(), colors::BLUE);
}
