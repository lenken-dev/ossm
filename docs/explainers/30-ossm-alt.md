# 30 — The OSSM ALT variant

> Prerequisites: [10-core-ossm.md](10-core-ossm.md),
> [12-boards-and-motors.md](12-boards-and-motors.md)

The [OSSM-ALT-Edition](https://github.com/jollydodo/OSSM-ALT-Edition) board:
an ESP32-S3 with built-in 28 V USB-PD, driving a 57AIM servo motor over
RS-485 / Modbus RTU. It is the reference target of this firmware, and the
machine the browser simulator renders.

This file covers what is specific to ALT. The shared layers are linked, not
repeated.

## The file chain

One variant is assembled from six files, each adding one decision:

```
firmware/esp32s3/src/bin/ossm-alt.rs   ← pins. Only this file is ALT-specific.
firmware/esp32s3/src/lib.rs            ← boot sequence, shared by all 3 S3 variants
firmware/esp32s3/src/{motor,board}.rs  ← 6-line cfg shims, real vs. simulated
ossm-esp/src/motor/rs485.rs            ← ESP-specific: UART setup, RS485 DE, provisioning
ossm-esp/src/board/rs485.rs            ← type alias for the generic board
boards/rs485/src/lib.rs                ← the generic, chip-independent Board impl
```

`waveshare` and `seeed-xiao` differ from `ossm-alt` **only** in the first
file — different GPIO numbers, same everything else. That is the entire cost
of supporting a new S3 board with an RS-485 motor.

## The bin file

```rust
#![no_std]
#![no_main]

use {esp_backtrace as _, esp_println as _};

esp_bootloader_esp_idf::esp_app_desc!();

#[esp_rtos::main]
async fn main(spawner: embassy_executor::Spawner) {
    let p = esp_hal::init(esp_hal::Config::default());

    let config = esp32s3::Config {
        motor: esp32s3::MotorConfig {
            uart1:    p.UART1,
            uart_tx:  p.GPIO10.into(),
            uart_rx:  p.GPIO12.into(),
            rs485_de: p.GPIO11.into(),
        },
        wifi:     p.WIFI,
        bt:       p.BT,
        timg0:    p.TIMG0,
        sw_int:   p.SW_INTERRUPT,
        cpu_ctrl: p.CPU_CTRL,
    };

    esp32s3::run(spawner, config).await;
}
```

- `#![no_std]` — no standard library ([rust/05](rust/05-no-std-and-statics.md)).
- `#![no_main]` — no C `main`; the entry point comes from the `#[esp_rtos::main]`
  attribute macro, which generates the real reset handler and starts an
  executor around this async function.
- `use {esp_backtrace as _, esp_println as _};` — importing purely for side
  effects. These crates register a panic handler and a `println!` sink by
  *existing*; `as _` says "link this crate, I will not name it".

**Peripherals are values, not addresses.** `esp_hal::init` returns a struct
whose fields are singleton handles: `p.UART1`, `p.GPIO10`. Each is a distinct
type and can be moved exactly once. Passing `p.UART1` into `MotorConfig` moves
it there; a second use of `p.UART1` anywhere in the program is a compile error.
So "two drivers accidentally configured the same UART" — a classic embedded bug
class — is structurally impossible. `.into()` converts a concrete `GPIO10` into
the type-erased `AnyPin` the config expects.

## The boot sequence

`firmware/esp32s3/src/lib.rs`, `pub async fn run`. Compare with the WASM
constructor in [20-wasm-simulator.md](20-wasm-simulator.md) — same steps.

```rust
pub async fn run(spawner: Spawner, config: Config) {
    // 1. Logging into the serial console.
    ossm::logging::init(log::LevelFilter::Info, |line| {
        esp_println::println!("{}", line);
    });
    ossm::build_info!();

    // 2. A 128 KB heap. Needed by Ruckig (`alloc` feature) and the radio stacks.
    esp_alloc::heap_allocator!(size: 128 * 1024);

    // 3. Start the RTOS/timer layer.
    let timg0 = TimerGroup::new(config.timg0);
    esp_rtos::start(timg0.timer0);

    // 4. Bring up the motor over RS-485 (this can take ~500 ms; see below).
    let motor = motor::build(config.motor).await;

    static MECHANICAL: MechanicalConfig = MechanicalConfig {
        pulley_teeth: 20,
        belt_pitch_mm: 2.0,
        reverse_direction: false,
    };
    let limits = MotionLimits::default();          // 10–190 mm, 600 mm/s

    // 5. Split the core handles; build the controller.
    let (receiver, _observer, motion) = OSSM_CELL.init(Ossm::new()).split();
    let board = board::build(motor, &MECHANICAL);
    let controller = receiver.into_controller(board, limits.clone(), UPDATE_INTERVAL_SECS);

    // 6. Move the motion loop onto core 1, on a priority-2 interrupt executor.
    let second_core = move || {
        let executor = EXECUTOR_CORE_1.init(InterruptExecutor::new(sw_int.software_interrupt2));
        let spawner = executor.start(Priority::Priority2);
        spawner.spawn(motion_task(controller)).unwrap();
        MOTION_READY.signal(true);
        loop {}
    };
    esp_rtos::start_second_core(config.cpu_ctrl, sw_int.software_interrupt0,
                                sw_int.software_interrupt1, app_core_stack, second_core);
    MOTION_READY.wait().await;

    // 7. Pattern engine + radios on core 0.
    let (runner, _observer, patterns) = PATTERNS_CELL.init(PatternEngine::new()).split();
    let patterns: &'static PatternSender = mk_static!(PatternSender, patterns);
    radio::start(&spawner, config.wifi, config.bt, patterns, &limits);

    runner.run(&motion, AnyPattern::all_builtin(), Delay).await
}
```

### Why two cores

```
   CPU core 0 (PRO)                    CPU core 1 (APP)
 ┌──────────────────────────┐        ┌──────────────────────────┐
 │ pattern engine runner    │        │ InterruptExecutor        │
 │ BLE GATT server          │        │   Priority::Priority2    │
 │ ESP-NOW remote           │        │   motion_task            │
 │ (default esp-rtos exec)  │        │   Ticker::every(10 ms)   │
 └──────────────────────────┘        └──────────────────────────┘
              │                                    ▲
              └────── Embassy channels ────────────┘
                  (CriticalSectionRawMutex)
```

The motion loop must tick every 10 ms regardless of what BLE is doing. Putting
it on an interrupt executor on the second core means a busy Bluetooth stack
cannot delay a Ruckig update. The two cores communicate only through the
`Ossm` channels, which use `CriticalSectionRawMutex` and are therefore safe
across cores.

`MOTION_READY` is a `Signal<CriticalSectionRawMutex, bool>` used as a one-shot
barrier: core 0 waits for core 1 to have spawned the motion task before it
starts anything that might command motion.

`motion_task` is the only real difference from the WASM version's
`spawn_local`:

```rust
#[embassy_executor::task]
async fn motion_task(mut controller: MotionController<'static, board::Board>) {
    let mut ticker = Ticker::every(Duration::from_micros(
        (UPDATE_INTERVAL_SECS * 1_000_000.0) as u64));
    loop {
        if let Err(e) = controller.update().await {
            log::error!("Motion controller fault: {:?}", e);
        }
        ticker.next().await;
    }
}
```

`#[embassy_executor::task]` allocates the future's storage in a static at
compile time — Embassy tasks need no heap and no stack of their own. See
[rust/04-async-and-embassy.md](rust/04-async-and-embassy.md).

## Hardware RS-485

RS-485 is half duplex: one differential pair, and a transceiver that must be
told which direction to drive. That is the DE (driver enable) pin — GPIO11 on
ALT.

The obvious implementation is to raise DE, write, `flush()`, lower DE. It is
also subtly wrong: `flush()` returns when the last byte has entered the shift
register, not when it has finished clocking out. Dropping DE there truncates
the final byte, intermittently, under load.

So this firmware uses the ESP32-S3's hardware RS-485 mode instead, and never
touches DE from software:

```rust
pub unsafe fn enable_uart1_rs485(de_pin: impl OutputPin) {
    let gpio_num = de_pin.number() as usize;

    // UART1's clock must already be on — otherwise register writes silently vanish.
    let system = unsafe { &*esp_hal::peripherals::SYSTEM::ptr() };
    assert!(system.perip_clk_en0().read().uart1_clk_en().bit_is_set(),
            "UART1 peripheral clock is not enabled - call Uart::new() first");

    // Known electrical state: push-pull, ~20 mA drive, no pulls.
    io_mux.gpio(gpio_num).modify(|_, w| unsafe {
        w.fun_drv().bits(2); w.fun_wpu().clear_bit(); w.fun_wpd().clear_bit(); w
    });

    // Enable RS485 half-duplex mode on UART1.
    uart.rs485_conf().modify(|_, w| {
        w.rs485_en().set_bit();
        w.dl0_en().clear_bit();
        w.dl1_en().clear_bit();
        w.rs485tx_rx_en().clear_bit();      // no TX→RX loopback
        w.rs485rxby_tx_en().clear_bit();    // don't start TX while RX is active
        // ...
    });

    // Route the UART1 DTR output signal to the DE pin through the GPIO matrix.
    gpio.func_out_sel_cfg(gpio_num).modify(|_, w| unsafe {
        w.out_sel().bits(UART1_DTR_SIGNAL);   // 17 on ESP32-S3
        w.oen_sel().clear_bit()               // peripheral controls output enable
    });
}
```

The UART peripheral then asserts DE in lockstep with its own shift register —
exactly for the duration of each transmitted byte including stop bits. No
timing race is possible.

Two Rust details:

- `unsafe fn` — this writes raw peripheral registers behind the HAL's back, so
  the caller must uphold an invariant the compiler cannot check (UART1 is
  initialised, nobody else owns it). The call site documents why it is sound;
  see [rust/05-no-std-and-statics.md](rust/05-no-std-and-statics.md).
- `de_pin: impl OutputPin` is taken **by value**. The function consumes the
  pin so no other code can reconfigure it afterwards. The ownership system
  used as a hardware lock.
- `compile_error!` at the top of the module rejects any chip other than
  ESP32-S3, because the DTR signal index (17) was verified only there.

## Motor bring-up and provisioning

```rust
pub async fn build(config: Config) -> Motor {
    let uart_config = UartConfig::default().with_baudrate(TARGET_BAUD_RATE.as_int());  // 115200
    let uart = Uart::new(config.uart1, uart_config)
        .expect("Failed to initialize UART")
        .with_tx(config.uart_tx)
        .with_rx(config.uart_rx);

    unsafe { crate::rs485::enable_uart1_rs485(config.rs485_de) };

    let transport = Rs485ModbusTransport::new(NonBlockingUart(uart), Delay);
    provision(transport, DEFAULT_DEVICE_ADDR, Motor57AIMConfig::default(), Delay).await
}
```

`NonBlockingUart` is a newtype wrapper (`pub struct NonBlockingUart<'d>(pub Uart<'d, Blocking>)`)
that implements `ReadNonBlocking` via `read_buffered()`, because the HAL's
`embedded_io::Read` blocks forever and would make Modbus timeouts impossible.

`provision` handles the factory-baud problem. The 57AIM ships at 19200 baud;
this firmware wants 115200:

```rust
pub async fn provision<T, D>(transport: T, device_addr: u8,
                             motor_config: Motor57AIMConfig, delay: D) -> Motor57AIM<Modbus<T>, D>
where T: ModbusTransport + UartReconfigure, D: DelayNs
{
    let mut motor = Motor57AIM::new(Modbus::new(transport, device_addr), motor_config, delay);
    motor.delay.delay_ms(500).await;                        // let the motor boot

    if motor.read_absolute_position().await.is_ok() {
        log::info!("Motor responsive at {} baud", TARGET_BAUD_RATE.as_int());
        return motor;                                        // normal path
    }

    // Silent at 115200 → assume a factory-fresh motor. Drop to 19200 and reprogram it.
    motor.interface.transport.reconfigure_baud(STOCK_BAUD_RATE.as_int()).await;
    motor.delay.delay_ms(100).await;
    motor.set_baud_rate(TARGET_BAUD_RATE).await;
    panic!("Power cycle required after motor baud provisioning");
}
```

The new rate is written to the motor's EEPROM and only takes effect after a
power cycle, so the panic is the correct outcome: there is nothing useful to
do until the user cycles power. This is a one-time event per motor.

`set_baud_rate` itself is a vendor magic sequence, and its last write
intentionally ignores its own error because the apply step never answers:

```rust
pub async fn set_baud_rate(&mut self, baud_rate: MotorBaudRate) -> Result<(), T::Error> {
    self.write_register(RwRegister::ModbusEnable, 1).await?;
    self.write_register(RwRegister::MotorAcceleration, baud_rate as u16).await?;
    self.write_register(RwRegister::WeakMagneticAngle, 129).await?;
    let _ = self.write_register(RwRegister::ModbusEnable, 506).await;   // no response expected
    Ok(())
}
```

## The 57AIM register map

The motor is a Modbus slave. `RwRegister` and `RoRegister` are `#[repr(u16)]`
enums whose discriminants are the register addresses:

```rust
#[repr(u16)]
pub enum RwRegister {
    ModbusEnable = 0x00,
    DriverOutputEnable = 0x01,
    MotorTargetSpeed = 0x02,
    MotorAcceleration = 0x03,
    DirPolarity = 0x09,
    AbsolutePositionLowU16 = 0x16,
    AbsolutePositionHighU16 = 0x17,
    StandstillMaxOutput = 0x18,
    SpecificFunction = 0x19,
    // ...
}
```

`#[repr(u16)]` fixes the in-memory representation so `reg as u16` yields the
address. This is the same idea as a C enum with explicit values, but the
conversion is explicit at every use, and you cannot pass an arbitrary integer
where a register is expected.

Read-only registers carry the telemetry the README advertises: `SystemCurrent`
(raw / 2000 = amps), `SystemVoltage` (raw / 327 = volts), `SystemTemperature`,
`AlarmCode`.

Position writes do **not** go through Modbus function 0x06, because a 32-bit
position split across two register writes could be observed half-updated.
Instead the vendor's atomic function `0x7B` is used through
`raw_transaction`:

```rust
pub async fn set_absolute_position(&mut self, steps: i32) -> Result<(), T::Error> {
    let mut request = [0u8; 6];
    request[0] = self.interface.device_addr;
    request[1] = SET_ABSOLUTE_POSITION_FUNC;              // 0x7B
    request[2..6].copy_from_slice(&steps.to_be_bytes());  // big-endian, explicit
    let mut response = [0u8; 8];
    self.interface.transport.raw_transaction(&request, &mut response).await?;
    Ok(())
}
```

`to_be_bytes()` — endianness is always spelled out; there is no `htonl`
guesswork.

This one call happens **every 10 ms**, forever. At 115200 baud a 6-byte
request plus CRC and an 8-byte response is roughly 1.4 ms, comfortably inside
the tick budget.

### Homing

The 57AIM homes itself, so `SelfHoming` delegates entirely to the motor:

```rust
impl<T: ModbusTransport, D: DelayNs> SelfHoming for Motor57AIM<Modbus<T>, D> {
    async fn home(&mut self) -> Result<(), Self::Error> {
        self.trigger_homing().await?;          // 80 rpm, output limited to 89, SpecificFunction=1

        loop {
            self.delay.delay_ms(50).await;
            let remaining = self.read_remaining_steps().await?;
            if remaining.abs() < 15 { break; }
        }

        self.delay.delay_ms(20).await;
        self.enable_driver().await?;           // homing resets Modbus mode on this motor
        self.delay.delay_ms(800).await;
        self.configure_max_tracking().await    // 3000 rpm, accel 50000, output 600
    }
}
```

The low `HOME_MAX_OUTPUT` (89 of 600) is what makes homing safe: the carriage
crawls into the end stop with limited torque. `configure_max_tracking()`
afterwards is the step that turns the motor back into a pure position servo —
the deliberate defeat of its internal planner described in
[12-boards-and-motors.md](12-boards-and-motors.md).

Above this, `Rs485Board::home()` first writes the direction polarity, and the
`MotionController` then moves to `min_position_mm` and enters `Ready`.

## Radios

`radio::start` brings up both remotes on core 0:

- **ESP-NOW** for the M5 hardware remote (`crates/ossm-m5-remote`), a
  connectionless Wi-Fi protocol.
- **BLE GATT** (`crates/ble-remote`, built on `trouble-host`) exposing a
  custom service with characteristics for commands, a speed knob, current
  state (notify), the pattern list, and pattern descriptions — the pattern list
  is serialised to JSON at runtime from `commands::pattern_list()`.

Both are handed the same `&'static PatternSender`. They cannot move the motor
directly; they can only issue `PatternCommand`s. This is the same capability
boundary the WASM `Simulator` sits behind.

## Feature plumbing: real vs. simulated motor

You can flash an ALT build with the fake motor from
[12-boards-and-motors.md](12-boards-and-motors.md), to bench-test the firmware
without a motor attached. The switch is entirely in `cfg` attributes:

```rust
// firmware/esp32s3/src/motor.rs
#[cfg(feature = "motor-rs485")]
pub use ossm_esp::motor::rs485::Config;

#[cfg(feature = "motor-sim")]
pub use ossm_esp::motor::sim::{Motor, build};

#[cfg(all(feature = "motor-rs485", not(feature = "motor-sim")))]
pub use ossm_esp::motor::rs485::build;
```

`motor-sim` deliberately *implies* `motor-rs485` in `Cargo.toml`, so the
`Config` type (with its pin fields) stays visible and `bin/ossm-alt.rs` does
not change between real and sim builds — the sim `build` just drops the pins
on the floor. Cargo features are additive, so this "pull in the sibling
feature for its types" idiom is the standard way to keep call sites uniform.
See [rust/06-cargo-and-builds.md](rust/06-cargo-and-builds.md).

```sh
just build ossm-alt        # real motor
just flash ossm-alt sim    # simulated motor, flashed to the board
```

## Building and flashing

`just build ossm-alt` runs `cargo run -p ossm-flash -- ossm-alt --build-only`.
`crates/ossm-flash` is an ordinary host-side CLI (clap + std) that owns the
variant table:

```rust
Variant::OssmAlt => VariantSpec {
    workspace: "firmware/esp32s3",
    bin: "ossm-alt",
    target: "xtensa-esp32s3-none-elf",
    default_motor: Motor::Rs485,
},
```

and shells out to:

```sh
cd firmware/esp32s3
cargo +esp build --release --bin ossm-alt --features motor-rs485
espflash flash --monitor target/xtensa-esp32s3-none-elf/release/ossm-alt
```

`+esp` selects the Espressif Rust toolchain — the ESP32/S3 are Xtensa cores,
which upstream LLVM does not support, so Espressif ships a patched compiler.
(The ESP32-C series is RISC-V and needs no such fork, but is not a target
here.)

`--target xtensa-esp32s3-none-elf`: `none` means no operating system, which is
what makes `#![no_std]` mandatory.

Because `firmware/esp32s3` is its own workspace with its own
`rust-toolchain.toml`, `cargo build` there does the right thing without
polluting the root workspace, which is built for the host. For editor support,
`just focus ossm-alt` symlinks that crate's config into the workspace root so
rust-analyzer analyses the right target.

## Build metadata

`ossm::build_info!()` logs the device, git commit, release id and build time on
boot. The values come from `build.rs`, which writes a null-separated blob into
`OUT_DIR` at compile time; the macro `include_bytes!`s it into a fixed 256-byte
struct placed in a dedicated ELF section:

```rust
#[unsafe(link_section = ".ossm.build_info")]
#[used]
static OSSM_BUILD_META: $crate::BuildMeta = $crate::BuildMeta::new(
    include_bytes!(concat!(env!("OUT_DIR"), "/ossm_build_info.bin")),
);
```

The separate section lets CI strip it before hashing a firmware image, so a
rebuild with only a new timestamp is recognised as unchanged. `#[used]` stops
the linker garbage-collecting a static nothing references.
