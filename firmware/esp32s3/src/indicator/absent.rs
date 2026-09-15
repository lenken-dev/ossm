use embassy_executor::Spawner;
use ossm::MotionObserver;
use pattern_engine::PatternObserver;

#[derive(Default)]
pub struct Config;

pub fn build(_config: Config) {}

pub fn start(
    _spawner: &Spawner,
    _indicator: (),
    _motion: MotionObserver,
    _engine: PatternObserver,
) {
}
