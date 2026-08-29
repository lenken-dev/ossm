# 12 — Boards, motors, and transports

> Prerequisites: [rust/02-traits-and-generics.md](rust/02-traits-and-generics.md)

Below the motion controller there are three trait layers. Each exists because
something varies independently of the others: the wire protocol, the motor's
feature set, and the PCB's pin assignment.

```
MotionController
      │  set_position(137.4 mm)
      ▼
   Board  ─────────────  boards/rs485, boards/stepdir, boards/sim-board
      │  set_absolute_position(112559 steps)
      ▼
   Motor  ─────────────  drivers/m57aim, drivers/sim-motor
      │  write_holding(addr, 0x16, value)
      ▼
 ModbusTransport ──────  ossm/src/transport/modbus_rtu.rs
      │  bytes
      ▼
  UART / GPIO
```

## `Board` — a position follower

```rust
#[allow(async_fn_in_trait)]
pub trait Board {
    type Error: Debug;

    async fn enable(&mut self)  -> Result<(), Self::Error>;
    async fn disable(&mut self) -> Result<(), Self::Error>;
    async fn home(&mut self)    -> Result<(), Self::Error>;
    async fn set_position(&mut self, position_mm: f64) -> Result<(), Self::Error>;
    async fn set_torque(&mut self, fraction: f64)      -> Result<(), Self::Error>;
    async fn position_mm(&mut self) -> Result<f64, Self::Error>;
    async fn tick(&mut self) -> Result<(), Self::Error>;
}
```

The whole design rests on one sentence from the doc comment:

> A `Board` is a **position follower** — it receives a position in millimetres
> every tick and makes the motor go there as fast as it can.

The board must never plan its own path, and the motor's *internal* trajectory
planner is deliberately defeated by configuring it for maximum tracking speed.
Two planners in series would compound unpredictably; there is exactly one, and
it is Ruckig in the controller.

`type Error: Debug` is an **associated type** — each implementation names its
own error type, and the controller is generic over it (`B::Error`). The
simulator's board uses `core::convert::Infallible`, an enum with no variants,
so error handling for it compiles to nothing.

`home()` is the one exception to "follower": there the board takes full
control, because homing mechanisms differ completely — a Modbus command, or
current-sensing stall detection, or a limit switch.

## `Motor` and its extension traits

```rust
pub trait Motor {
    type Error: core::fmt::Debug;
    fn steps_per_rev(&self) -> u32;
    fn max_output(&self) -> u16;
    async fn enable(&mut self)  -> Result<(), Self::Error>;
    async fn disable(&mut self) -> Result<(), Self::Error>;
    async fn set_absolute_position(&mut self, steps: i32)  -> Result<(), Self::Error>;
    async fn read_absolute_position(&mut self) -> Result<i32, Self::Error>;
    async fn set_max_output(&mut self, output: u16) -> Result<(), Self::Error>;
}
```

Capabilities that only *some* motors have live in separate traits that require
`Motor`:

```rust
pub trait Rs485Motor: Motor {
    async fn set_dir_polarity(&mut self, _reverse: bool) -> Result<(), Self::Error> { Ok(()) }
}

pub trait SelfHoming: Motor {
    async fn home(&mut self) -> Result<(), Self::Error>;
}

pub trait StepDir: Motor {
    fn reset_position(&mut self, position: i32);
}
```

`Rs485Motor: Motor` is a **supertrait** bound: you cannot implement
`Rs485Motor` without also implementing `Motor`. This is how the codebase says
"a motor that homes itself" without an `Option<fn>` or a runtime capability
flag — the board declares which capabilities it needs in its own bounds, and a
motor that lacks them fails to compile.

That is exactly what the RS-485 board does:

```rust
pub struct Rs485Board<M: Rs485Motor + SelfHoming> {
    motor: M,
    mechanical: &'static MechanicalConfig,
}

impl<M: Rs485Motor + SelfHoming> Board for Rs485Board<M> {
    type Error = BoardError<M::Error>;

    async fn home(&mut self) -> Result<(), Self::Error> {
        self.motor.set_dir_polarity(self.mechanical.reverse_direction)
            .await.map_err(BoardError::Motor)?;
        self.motor.home().await.map_err(BoardError::Motor)
    }

    async fn set_position(&mut self, position_mm: f64) -> Result<(), Self::Error> {
        let steps = self.mechanical.mm_to_steps(position_mm, self.motor.steps_per_rev());
        self.motor.set_absolute_position(steps).await.map_err(BoardError::Motor)
    }
    // ...
}
```

The board is where mm becomes steps, and where the board's error type wraps
the motor's (`BoardError<M::Error>`). No dynamic dispatch: `M` is a concrete
type at compile time, so these calls are direct and inlinable. This is C++
template-style static polymorphism, but with the interface checked at the
definition site rather than at instantiation.

## Transports

`ModbusTransport` abstracts the wire protocol:

```rust
pub trait ModbusTransport {
    type Error: core::fmt::Debug;
    async fn write_holding(&mut self, device_addr: u8, register: u16, value: u16)
        -> Result<(), Self::Error>;
    async fn read_holding(&mut self, device_addr: u8, register: u16, count: u16)
        -> Result<Vec<u16, 8>, Self::Error>;
    async fn raw_transaction(&mut self, request: &[u8], response: &mut [u8])
        -> Result<usize, Self::Error>;
}
```

`Vec<u16, 8>` is `heapless::Vec` — a fixed-capacity vector stored inline, no
allocator involved. Standard practice in `no_std`; see
[rust/05-no-std-and-statics.md](rust/05-no-std-and-statics.md).

`raw_transaction` exists for vendor function codes that are not standard
Modbus — the 57AIM's atomic 4-byte position write is function `0x7B`.

`Rs485ModbusTransport` is the RTU implementation: it builds frames with the
`rmodbus` crate, appends a CRC-16, writes, then reads the reply with a 100 ms
deadline and up to 3 retries. Two supporting traits make that possible on
embedded hardware:

```rust
/// Non-blocking read: returns 0 immediately when no data is available.
pub trait ReadNonBlocking: ErrorType {
    fn read_nb(&mut self, buf: &mut [u8]) -> Result<usize, Self::Error>;
}

pub trait UartReconfigure {
    type Error: core::fmt::Debug;
    async fn reconfigure_baud(&mut self, baud: u32) -> Result<(), Self::Error>;
}
```

`ReadNonBlocking` exists because `embedded_io::Read` on a blocking UART waits
forever, which makes timeouts impossible. `UartReconfigure` exists so a motor
driver can ask for a baud change without knowing anything about the MCU — used
during one-shot provisioning; see [30-ossm-alt.md](30-ossm-alt.md).

Errors are classified by whether retrying helps:

```rust
pub enum TransportError<E: core::fmt::Debug> {
    Uart(E),
    Timeout,
    /// Wire corruption: garbled header, CRC mismatch, etc. Retryable.
    Corrupt(&'static str),
    /// Logic/programming error: failed to build request, buffer too small. Fatal.
    Protocol(&'static str),
}
```

## The simulated stack

For contrast, the entire fake hardware stack is about 100 lines. The motor:

```rust
pub struct SimMotor { position: i32, enabled: bool }

impl SimMotor {
    pub const STEPS_PER_REV: u32 = 32_768;
    pub async fn set_absolute_position(&mut self, steps: i32) -> Result<(), Infallible> {
        self.position = steps;
        Ok(())
    }
    pub fn position(&self) -> i32 { self.position }
}
```

and the board is a thin `Board` impl over it that does the same mm→steps
conversion as the real one:

```rust
impl Board for SimBoard {
    type Error = Infallible;

    async fn set_position(&mut self, position_mm: f64) -> Result<(), Self::Error> {
        let steps = self.mechanical.mm_to_steps(position_mm, SimMotor::STEPS_PER_REV);
        self.motor.set_absolute_position(steps).await
    }
    async fn tick(&mut self) -> Result<(), Self::Error> { Ok(()) }
    // ...
}
```

There is no physics model. `SimMotor` is a perfect servo: commanded position
*is* actual position, instantly. Everything above it — the state machine, the
planner, the patterns — is the real firmware code. That is precisely the point
of the trait boundary, and it is why the browser simulator is a genuine test
of the control logic rather than a re-implementation of it. See
[20-wasm-simulator.md](20-wasm-simulator.md).

## Adding a new motor

1. Write a driver crate implementing `Motor` (plus `SelfHoming` / `StepDir` /
   `Rs485Motor` as applicable).
2. Reuse an existing `Board` if the shape fits, or write one.
3. Wire it up in `ossm-esp` behind a `motor-*` feature and reference it from a
   firmware bin.

Nothing above the board changes.
