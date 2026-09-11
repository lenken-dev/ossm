use std::{cell::Cell, rc::Rc};

use embassy_futures::block_on;
use status_indicator::{ColorIndicator, Indicator, PanicIndicator, Rgb};
use ws2812b_indicator::{PanicPixelWriter, PixelWriter, Ws2812b};

/// Simulates the LED at the external transport boundary, including retained
/// output from an earlier firmware run.
struct LedWire(Rc<Cell<[u8; 3]>>);

impl PixelWriter for LedWire {
    type Error = core::convert::Infallible;
    type Panic = LedWire;

    fn take_panic_writer(&mut self) -> Option<Self::Panic> {
        Some(LedWire(self.0.clone()))
    }

    async fn write(&mut self, grb: [u8; 3]) -> Result<(), Self::Error> {
        self.0.set(grb);
        Ok(())
    }
}

impl PanicPixelWriter for LedWire {
    type Error = core::convert::Infallible;

    fn write_panic(&mut self, grb: [u8; 3]) -> Result<(), Self::Error> {
        self.0.set(grb);
        Ok(())
    }
}

#[test]
fn panic_overrides_an_off_led_with_capped_red_without_polling() {
    let led = Rc::new(Cell::new([0, 0, 0]));
    let mut indicator = block_on(Ws2812b::new(LedWire(led.clone()), Rgb::BLUE)).unwrap();
    let mut panic = indicator.take_panic_indicator().unwrap();
    assert!(indicator.take_panic_indicator().is_none());
    panic.indicate_panic().unwrap();
    assert_eq!(led.get(), [0, 51, 0]);
}

struct PendingWire {
    led: Rc<Cell<[u8; 3]>>,
    pending: Rc<Cell<bool>>,
}

impl PixelWriter for PendingWire {
    type Error = core::convert::Infallible;
    type Panic = LedWire;

    fn take_panic_writer(&mut self) -> Option<Self::Panic> {
        Some(LedWire(self.led.clone()))
    }

    async fn write(&mut self, grb: [u8; 3]) -> Result<(), Self::Error> {
        self.led.set(grb);
        if self.pending.get() {
            core::future::pending::<()>().await;
        }
        Ok(())
    }
}

#[test]
fn panic_can_override_a_normal_write_that_never_completes() {
    use core::{
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
    };

    let led = Rc::new(Cell::new([0, 0, 0]));
    let pending = Rc::new(Cell::new(false));
    let mut indicator = block_on(Ws2812b::new(
        PendingWire {
            led: led.clone(),
            pending: pending.clone(),
        },
        Rgb::GREEN,
    ))
    .unwrap();
    let mut panic = indicator.take_panic_indicator().unwrap();
    pending.set(true);
    let mut update = pin!(indicator.set_on(true));
    assert!(matches!(
        update
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    assert_eq!(led.get(), [255, 0, 0]);
    panic.indicate_panic().unwrap();
    assert_eq!(led.get(), [0, 51, 0]);
}

#[test]
fn initialization_clears_an_already_lit_led() {
    block_on(async {
        let led = Rc::new(Cell::new([20, 30, 40]));
        let _indicator = Ws2812b::new(LedWire(led.clone()), Rgb::new(10, 0, 0))
            .await
            .unwrap();
        assert_eq!(led.get(), [0, 0, 0]);
    });
}

#[test]
fn on_off_and_color_changes_preserve_the_selected_color() {
    block_on(async {
        let led = Rc::new(Cell::new([0, 0, 0]));
        let mut indicator = Ws2812b::new(LedWire(led.clone()), Rgb::new(10, 0, 0))
            .await
            .unwrap();
        indicator.set_on(true).await.unwrap();
        assert_eq!(led.get(), [0, 10, 0]);
        indicator.set_on(false).await.unwrap();
        assert_eq!(led.get(), [0, 0, 0]);
        indicator.set_color(Rgb::new(0, 0, 20)).await.unwrap();
        assert_eq!(led.get(), [0, 0, 0]);
        indicator.set_on(true).await.unwrap();
        assert_eq!(led.get(), [0, 0, 20]);
        indicator.set_color(Rgb::new(30, 40, 50)).await.unwrap();
        assert_eq!(led.get(), [40, 30, 50]);
    });
}

#[derive(Debug, PartialEq, Eq)]
struct WriteError;

struct FallibleWire {
    led: Rc<Cell<[u8; 3]>>,
    fail: Rc<Cell<bool>>,
}

impl PixelWriter for FallibleWire {
    type Error = WriteError;
    type Panic = FallibleWire;

    fn take_panic_writer(&mut self) -> Option<Self::Panic> {
        Some(FallibleWire {
            led: self.led.clone(),
            fail: self.fail.clone(),
        })
    }

    async fn write(&mut self, grb: [u8; 3]) -> Result<(), Self::Error> {
        if self.fail.get() {
            return Err(WriteError);
        }
        self.led.set(grb);
        Ok(())
    }
}

impl PanicPixelWriter for FallibleWire {
    type Error = WriteError;

    fn write_panic(&mut self, grb: [u8; 3]) -> Result<(), Self::Error> {
        if self.fail.get() {
            return Err(WriteError);
        }
        self.led.set(grb);
        Ok(())
    }
}

#[test]
fn failed_panic_output_returns_control_to_the_handler() {
    let led = Rc::new(Cell::new([0, 0, 0]));
    let fail = Rc::new(Cell::new(false));
    let mut indicator = block_on(Ws2812b::new(
        FallibleWire {
            led,
            fail: fail.clone(),
        },
        Rgb::GREEN,
    ))
    .unwrap();
    let mut panic = indicator.take_panic_indicator().unwrap();
    fail.set(true);
    assert_eq!(panic.indicate_panic(), Err(WriteError));
}

#[test]
fn initialization_reports_a_failed_clear() {
    block_on(async {
        let result = Ws2812b::new(
            FallibleWire {
                led: Rc::new(Cell::new([1, 2, 3])),
                fail: Rc::new(Cell::new(true)),
            },
            Rgb::new(10, 0, 0),
        )
        .await;
        assert!(matches!(result, Err(WriteError)));
    });
}

#[test]
fn failed_updates_report_errors_and_can_be_retried() {
    block_on(async {
        let led = Rc::new(Cell::new([0, 0, 0]));
        let fail = Rc::new(Cell::new(false));
        let mut indicator = Ws2812b::new(
            FallibleWire {
                led: led.clone(),
                fail: fail.clone(),
            },
            Rgb::new(10, 0, 0),
        )
        .await
        .unwrap();

        fail.set(true);
        assert_eq!(indicator.set_on(true).await, Err(WriteError));
        // A failed turn-on leaves the indicator logically off, so this color
        // change needs no hardware write, even while the transport is failing.
        indicator.set_color(Rgb::new(0, 0, 20)).await.unwrap();
        fail.set(false);
        indicator.set_on(true).await.unwrap();
        assert_eq!(led.get(), [0, 0, 20]);

        fail.set(true);
        assert_eq!(
            indicator.set_color(Rgb::new(30, 0, 0)).await,
            Err(WriteError)
        );
        assert_eq!(indicator.set_on(false).await, Err(WriteError));
        // Failed turn-off must not make subsequent color changes silently
        // become remembered-only updates while the LED may still be lit.
        assert_eq!(
            indicator.set_color(Rgb::new(0, 40, 0)).await,
            Err(WriteError)
        );

        fail.set(false);
        indicator.set_on(false).await.unwrap();
        assert_eq!(led.get(), [0, 0, 0]);
        indicator.set_on(true).await.unwrap();
        assert_eq!(led.get(), [0, 0, 20]);
    });
}
