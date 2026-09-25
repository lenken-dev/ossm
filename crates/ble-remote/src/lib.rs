#![no_std]

mod latency;
mod lite;
mod stream;

use core::{
    fmt::Write,
    sync::atomic::{AtomicBool, Ordering},
};

pub const CONNECTIONS_MAX: usize = 1;
pub const L2CAP_CHANNELS_MAX: usize = 2;
pub const MAX_COMMAND_LENGTH: usize = 64;
pub const MAX_STATE_LENGTH: usize = 160;
pub const MAX_PATTERN_LENGTH: usize = 1024;

use embassy_executor::Spawner;
use embassy_futures::select::{Either, select};
use embassy_time::{Duration, Ticker, Timer};
use esp_radio::ble::controller::BleConnector;
use heapless::String;
use log::{error, info, warn};
use pattern_engine::{EngineState, PatternInput, PatternSender, commands};
use static_cell::StaticCell;
use stream_engine::StreamSender;
use trouble_host::prelude::*;

use crate::latency::LatencyCompensation;
use crate::lite::LiteSession;
use crate::stream::StreamSession;

const SERVICE_UUID: Uuid = uuid!("522b443a-4f53-534d-0001-420badbabe69");
const PRIMARY_COMMAND_UUID: Uuid = uuid!("522b443a-4f53-534d-1000-420badbabe69");
const SPEED_KNOB_UUID: Uuid = uuid!("522b443a-4f53-534d-1010-420badbabe69");
const LATENCY_COMPENSATION_UUID: Uuid = uuid!("522b443a-4f53-534d-1030-420badbabe69");
const CURRENT_STATE_UUID: Uuid = uuid!("522b443a-4f53-534d-2000-420badbabe69");
const PATTERN_LIST_UUID: Uuid = uuid!("522b443a-4f53-534d-3000-420badbabe69");
const PATTERN_DESCRIPTION_UUID: Uuid = uuid!("522b443a-4f53-534d-3010-420badbabe69");

/// AD type of an incomplete list of 128-bit service UUIDs. The advertisement
/// and the scan response each list one of the two services.
const INCOMPLETE_SERVICE_UUIDS_128: u8 = 0x06;

static CONNECTED: AtomicBool = AtomicBool::new(false);

macro_rules! mk_static {
    ($t:ty, $val:expr) => {{
        static STATIC_CELL: StaticCell<$t> = StaticCell::new();
        STATIC_CELL.init($val)
    }};
}

#[gatt_server]
struct Server {
    ossm_service: OssmService,
    lite_service: LiteService,
}

#[gatt_service(uuid = SERVICE_UUID)]
struct OssmService {
    #[characteristic(uuid = PRIMARY_COMMAND_UUID, read, write, write_without_response)]
    primary_command: String<MAX_COMMAND_LENGTH>,

    #[characteristic(uuid = SPEED_KNOB_UUID, read, write)]
    speed_knob: String<16>,

    #[characteristic(uuid = LATENCY_COMPENSATION_UUID, read, write)]
    latency_compensation: String<{ latency::MAX_CONFIG_LENGTH }>,

    #[characteristic(uuid = CURRENT_STATE_UUID, read, notify)]
    current_state: String<MAX_STATE_LENGTH>,

    #[characteristic(uuid = PATTERN_LIST_UUID, read)]
    pattern_list: String<MAX_PATTERN_LENGTH>,

    #[characteristic(uuid = PATTERN_DESCRIPTION_UUID, read, write)]
    pattern_description: String<MAX_PATTERN_LENGTH>,
}

/// OSSM-Lite compatible streaming service (see [`lite`]).
#[gatt_service(uuid = lite::SERVICE_UUID)]
struct LiteService {
    #[characteristic(uuid = lite::STREAM_UUID, read, write, write_without_response)]
    stream: String<{ stream::MAX_POINT_LENGTH }>,

    #[characteristic(uuid = lite::SPEED_UUID, read, write)]
    speed: String<{ lite::MAX_SETTING_LENGTH }>,

    #[characteristic(uuid = lite::MAX_DEPTH_UUID, read, write)]
    max_depth: String<{ lite::MAX_SETTING_LENGTH }>,

    #[characteristic(uuid = lite::MIN_DEPTH_UUID, read, write)]
    min_depth: String<{ lite::MAX_SETTING_LENGTH }>,
}

fn get_all_patterns_json() -> String<MAX_PATTERN_LENGTH> {
    let mut output: String<MAX_PATTERN_LENGTH> = String::new();
    output.write_char('[').ok();
    for (i, meta) in commands::pattern_list().iter().enumerate() {
        let rollback = output.len();
        let sep = if i > 0 { "," } else { "" };
        if write!(output, r#"{sep}{{"name":"{}","idx":{i}}}"#, meta.name).is_err()
            || output.len() + 1 > output.capacity()
        {
            output.truncate(rollback);
            error!("Pattern list truncated at index {i}");
            break;
        }
    }
    output.write_char(']').ok();
    output
}

fn get_pattern_description(index: usize) -> String<MAX_PATTERN_LENGTH> {
    let mut output = String::new();

    let description = commands::pattern_description(index).unwrap_or("Invalid pattern index");

    if output.push_str(description).is_err() {
        output
            .push_str("Pattern Description Too Long")
            .expect("Always fits");
    }

    output
}

/// Start the BLE remote.
///
/// Two funscript players can stream: the OSSM-Lite one through its own
/// service, and the official OSSM one through `go:streaming` and
/// `stream:<position>:<duration ms>` commands. Without a `stream`, the
/// OSSM-Lite service is not advertised, streamed points are ignored, and
/// `go:streaming` fails.
pub fn start(
    spawner: &Spawner,
    connector: BleConnector<'static>,
    patterns: &'static PatternSender,
    stream: Option<&'static StreamSender>,
) {
    let bt_controller: ExternalController<_, 20> = ExternalController::new(connector);

    let resources = mk_static!(HostResources<DefaultPacketPool, CONNECTIONS_MAX, L2CAP_CHANNELS_MAX>, HostResources::new());
    let stack = mk_static!(
        trouble_host::Stack<
            'static,
            ExternalController<BleConnector<'static>, 20>,
            DefaultPacketPool,
        >,
        trouble_host::new(bt_controller, resources)
    );

    let Host {
        peripheral, runner, ..
    } = stack.build();

    spawner.must_spawn(ble_runner_task(runner));
    spawner.must_spawn(ble_events_task(stack, peripheral, patterns, stream));

    info!("BLE remote tasks started, waiting for connection...");
}

#[embassy_executor::task]
pub async fn ble_events_task(
    stack: &'static Stack<
        'static,
        ExternalController<BleConnector<'static>, 20>,
        DefaultPacketPool,
    >,
    mut peripheral: Peripheral<
        'static,
        ExternalController<BleConnector<'static>, 20>,
        DefaultPacketPool,
    >,
    patterns: &'static PatternSender,
    stream: Option<&'static StreamSender>,
) {
    info!("Starting advertising and GATT service");
    let server = Server::new_with_config(GapConfig::Peripheral(PeripheralConfig {
        name: "OSSM",
        appearance: &appearance::motorized_device::GENERIC_MOTORIZED_DEVICE,
    }))
    .unwrap();

    loop {
        match advertise("OSSM-rs", &mut peripheral, stream.is_some()).await {
            Ok(connection) => {
                CONNECTED.store(true, Ordering::Release);
                info!("BLE Connected");

                Timer::after_millis(100).await;

                if let Err(err) = connection.set_phy(stack, PhyKind::Le2M).await {
                    warn!("Failed to set 2M PHY, continuing with default: {:?}", err);
                }

                let connect_params = ConnectParams {
                    min_connection_interval: Duration::from_micros(7500),
                    max_connection_interval: Duration::from_micros(7500),
                    ..Default::default()
                };
                match connection
                    .update_connection_params(stack, &connect_params)
                    .await
                {
                    Ok(()) => info!("Connection interval set to 7.5ms"),
                    Err(err) => warn!(
                        "Failed to update connection params, continuing with defaults: {:?}",
                        err
                    ),
                }

                Timer::after_millis(100).await;

                match connection.read_phy(stack).await {
                    Ok(phy) => info!("PHY {:?} MTU {:?}", phy, connection.att_mtu()),
                    Err(err) => warn!(
                        "Could not read PHY: {:?}, MTU {:?}",
                        err,
                        connection.att_mtu()
                    ),
                };

                let gatt_connection = connection
                    .with_attribute_server(&server)
                    .expect("Could not transform connection into GATT connection");

                let latency = LatencyCompensation::new();
                let events =
                    gatt_events_task(&server, &gatt_connection, patterns, stream, &latency);
                let notify =
                    state_notifications(&server, &gatt_connection, patterns, stream, &latency);

                match select(events, notify).await {
                    Either::First(res) => {
                        if let Err(err) = res {
                            error!("[gatt] error in events task: {:?}", err);
                        }
                    }
                    Either::Second(res) => match res {
                        Ok(()) => info!("[gatt] notify task ended cleanly"),
                        Err(err) => error!("[gatt] error in notify task: {:?}", err),
                    },
                }

                stop(patterns, stream);
                info!("BLE session ended, stopping engine");
            }
            Err(err) => {
                error!("[adv] error: {:?}", err);
            }
        }
    }
}

#[embassy_executor::task]
pub async fn ble_runner_task(
    mut runner: Runner<'static, ExternalController<BleConnector<'static>, 20>, DefaultPacketPool>,
) {
    loop {
        if let Err(err) = runner.run().await {
            error!("[ble_task] error: {:?}", err);
        }
    }
}

async fn gatt_events_task<P: PacketPool>(
    server: &Server<'_>,
    connection: &GattConnection<'_, '_, P>,
    patterns: &'static PatternSender,
    stream: Option<&'static StreamSender>,
    latency: &LatencyCompensation,
) -> Result<(), Error> {
    let mut session = StreamSession::new(stream);
    let lite = LiteSession::new(patterns);
    let reason = loop {
        match connection.next().await {
            GattConnectionEvent::Disconnected { reason } => break reason,
            GattConnectionEvent::Gatt { event } => {
                let mut write = false;
                let mut event_handle = 0;
                let mut latency_reply = None;
                match &event {
                    GattEvent::Read(event) => {
                        if event.handle() == server.ossm_service.current_state.handle {
                            let engine_state = patterns.state();
                            let input = patterns.input();
                            let state_json =
                                state_to_json(engine_state, &input, is_streaming(stream), latency);
                            server.set(&server.ossm_service.current_state, &state_json)?;
                        }
                        if event.handle() == server.ossm_service.latency_compensation.handle {
                            server
                                .set(&server.ossm_service.latency_compensation, &latency.text())?;
                        }
                        if event.handle() == server.ossm_service.pattern_list.handle {
                            let patterns = get_all_patterns_json();
                            server.set(&server.ossm_service.pattern_list, &patterns)?;
                        }
                        lite.on_read(server, event.handle())?;
                    }
                    GattEvent::Write(event) => {
                        write = true;
                        event_handle = event.handle();
                        if event_handle == server.ossm_service.latency_compensation.handle {
                            let reply = latency.on_write(event.data());
                            info!("Latency compensation: {}", reply);
                            latency_reply = Some(reply);
                        }
                        lite.on_write(server, &mut session, event_handle, event.data());
                    }
                    GattEvent::Other(_) => {}
                };
                // This step is also performed at drop(), but writing it explicitly is necessary
                // in order to ensure reply is sent.
                match event.accept() {
                    Ok(reply) => reply.send().await,
                    Err(e) => {
                        error!("[gatt] error sending response: {:?}", e);
                    }
                };

                // Replace the written value with the reply once the write is applied.
                if let Some(reply) = latency_reply {
                    server.set(&server.ossm_service.latency_compensation, &reply)?;
                }

                // This is here because the event needs to be accepted before the data can be accessed
                if write {
                    if event_handle == server.ossm_service.primary_command.handle {
                        let command: String<MAX_COMMAND_LENGTH> =
                            server.get(&server.ossm_service.primary_command)?;

                        process_command(&command, server, patterns, stream, &mut session, latency);
                    }
                    if event_handle == server.ossm_service.pattern_description.handle {
                        let command: String<MAX_PATTERN_LENGTH> =
                            server.get(&server.ossm_service.pattern_description)?;

                        let description = if let Ok(index) = command.parse::<usize>() {
                            get_pattern_description(index)
                        } else {
                            let mut description: String<MAX_PATTERN_LENGTH> = String::new();
                            description
                                .push_str("Could not parse pattern index")
                                .expect("Always fits");
                            description
                        };

                        server.set(&server.ossm_service.pattern_description, &description)?;
                    }
                }
            }
            GattConnectionEvent::PhyUpdated { .. }
            | GattConnectionEvent::ConnectionParamsUpdated { .. }
            | GattConnectionEvent::RequestConnectionParams { .. }
            | GattConnectionEvent::DataLengthUpdated { .. } => {}
        }
    };
    CONNECTED.store(false, Ordering::Release);
    info!("[gatt] disconnected: {:?}", reason);
    session.log_summary();
    Ok(())
}

/// Create an advertiser to use to connect to a BLE Central, and wait for it to connect.
///
/// The advertisement has no room for a second 128-bit service UUID, so the
/// OSSM-Lite service is listed in the scan response when `streaming`.
async fn advertise<'values, 'server, C: Controller>(
    name: &'values str,
    peripheral: &mut Peripheral<'values, C, DefaultPacketPool>,
    streaming: bool,
) -> Result<Connection<'values, DefaultPacketPool>, BleHostError<C::Error>> {
    let mut advertiser_data = [0; 31];
    let len = AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::Unknown {
                ty: INCOMPLETE_SERVICE_UUIDS_128,
                data: SERVICE_UUID.as_raw(),
            },
            AdStructure::CompleteLocalName(name.as_bytes()),
        ],
        &mut advertiser_data[..],
    )?;

    let mut scan_data = [0; 31];
    let scan_len = if streaming {
        AdStructure::encode_slice(
            &[AdStructure::Unknown {
                ty: INCOMPLETE_SERVICE_UUIDS_128,
                data: lite::SERVICE_UUID.as_raw(),
            }],
            &mut scan_data[..],
        )?
    } else {
        0
    };

    let advertiser = peripheral
        .advertise(
            &Default::default(),
            Advertisement::ConnectableScannableUndirected {
                adv_data: &advertiser_data[..len],
                scan_data: &scan_data[..scan_len],
            },
        )
        .await?;
    info!("[adv] advertising");
    let conn = advertiser.accept().await?;
    info!("[adv] connection established");
    Ok(conn)
}

async fn state_notifications<P: PacketPool>(
    server: &Server<'_>,
    connection: &GattConnection<'_, '_, P>,
    patterns: &'static PatternSender,
    stream: Option<&'static StreamSender>,
    latency: &LatencyCompensation,
) -> Result<(), Error> {
    let mut sub = patterns
        .subscribe()
        .expect("No state subscriber slots available");
    let mut heartbeat = Ticker::every(Duration::from_secs(1));

    loop {
        let engine_state = match select(sub.next_message_pure(), heartbeat.next()).await {
            Either::First(state) => state,
            Either::Second(_) => patterns.state(),
        };

        let input = patterns.input();
        let state_json = state_to_json(engine_state, &input, is_streaming(stream), latency);
        server
            .ossm_service
            .current_state
            .notify(connection, &state_json)
            .await?;
    }
}

/// Whether streaming is active. It overrides the pattern state reported to
/// remotes.
fn is_streaming(stream: Option<&StreamSender>) -> bool {
    stream.is_some_and(StreamSender::is_active)
}

/// Stop streaming, then the pattern engine.
fn stop(patterns: &PatternSender, stream: Option<&StreamSender>) {
    if let Some(stream) = stream {
        stream.stop();
    }
    patterns.stop();
}

fn state_to_json(
    state: EngineState,
    input: &PatternInput,
    streaming: bool,
    latency: &LatencyCompensation,
) -> String<MAX_STATE_LENGTH> {
    let pattern_name = match state {
        EngineState::Playing(idx) | EngineState::Paused(idx) => commands::pattern_list()
            .get(idx)
            .map(|m| m.name)
            .unwrap_or(""),
        _ => "",
    };
    let mut out: String<MAX_STATE_LENGTH> = String::new();
    let state_str = match state {
        _ if streaming => "streaming",
        EngineState::Idle => "idle",
        EngineState::Homing => "homing",
        EngineState::Ready => "ready",
        EngineState::Playing(_) => "playing",
        EngineState::Paused(_) => "paused",
    };
    let idx = match state {
        EngineState::Playing(i) | EngineState::Paused(i) => i,
        _ => 0,
    };
    let speed = (input.velocity * 100.0) as u32;
    let stroke = (input.stroke * 100.0) as u32;
    let depth = (input.depth * 100.0) as u32;
    // Map internal -1.0..1.0 back to BLE protocol 0–100.
    let sensation = ((input.sensation + 1.0) * 50.0) as u32;
    let buffer = latency.buffer_value();
    let _ = write!(
        out,
        r#"{{"state":"{state_str}","speed":{speed},"stroke":{stroke},"sensation":{sensation},"depth":{depth},"buffer":{buffer},"pattern":{idx},"patternName":"{pattern_name}"}}"#,
    );
    out
}

fn process_command(
    command: &String<MAX_COMMAND_LENGTH>,
    server: &Server<'_>,
    patterns: &'static PatternSender,
    stream: Option<&'static StreamSender>,
    session: &mut StreamSession,
    latency: &LatencyCompensation,
) {
    // Points arrive many times a second; the session counts them instead of
    // logging each.
    if let Some(point) = command.strip_prefix("stream:") {
        let streamed = session.push(point.as_bytes(), latency.delay_ms());
        respond(server, command, !streamed);
        return;
    }

    info!("BLE Command {}", command);

    let mut split_command = command.split(":");

    let mut fail = false;

    if let Some(cmd) = split_command.next() {
        if let Some(action) = split_command.next() {
            match cmd {
                "set" => {
                    if let Some(value) = split_command.next() {
                        if action == "buffer" {
                            if !latency.set_buffer(value) {
                                error!("Could not parse buffer value");
                                fail = true;
                            }
                        } else if let Ok(value) = value.parse::<u32>() {
                            let normalized = value as f64 / 100.0;
                            match action {
                                "speed" => patterns.set_speed(normalized),
                                "stroke" => patterns.set_stroke(normalized),
                                "depth" => patterns.set_depth(normalized),
                                // BLE sends 0–100; internal range is -1.0..1.0.
                                "sensation" => patterns.set_sensation(normalized * 2.0 - 1.0),
                                "pattern" => patterns.play(value as usize),
                                _ => {
                                    error!("Invalid set command {}", action);
                                    fail = true;
                                }
                            }
                        } else {
                            error!("Could not parse set value");
                            fail = true;
                        };
                    } else {
                        error!("No value after set");
                        fail = true;
                    }
                }
                "go" => match action {
                    "simplePenetration" | "strokeEngine" => patterns.play(0),
                    "streaming" => fail = !go_streaming(patterns, stream),
                    "menu" => stop(patterns, stream),
                    _ => {
                        error!("Unknown go action: {}", action);
                        fail = true;
                    }
                },
                _ => {
                    error!("Unknown command: {}", cmd);
                    fail = true;
                }
            }
        } else {
            error!("No action in command");
            fail = true;
        }
    } else {
        error!("Invalid command");
        fail = true;
    }

    respond(server, command, fail);
}

/// Prepare for streaming by the official funscript player: stop a pattern
/// session, which also zeroes the speed, so that streamed points can take
/// over once the speed is raised. An active stream is left alone. Fails
/// without streaming.
fn go_streaming(patterns: &PatternSender, stream: Option<&StreamSender>) -> bool {
    let Some(stream) = stream else {
        error!("Streaming unavailable");
        return false;
    };
    if !stream.is_active()
        && matches!(
            patterns.state(),
            EngineState::Playing(_) | EngineState::Paused(_)
        )
    {
        patterns.stop();
    }
    true
}

/// Reply to a command in the command characteristic: `ok:` or `fail:`
/// followed by the command.
fn respond(server: &Server<'_>, command: &str, fail: bool) {
    let mut response_str: String<MAX_COMMAND_LENGTH> = String::new();
    if fail {
        response_str.write_str("fail:").expect("Should always fit");
        if response_str.write_str(command).is_err() {
            response_str
                .write_str("overflow")
                .expect("Should always fit");
        }
    } else {
        response_str.write_str("ok:").expect("Should always fit");
        if response_str.write_str(command).is_err() {
            response_str
                .write_str("overflow")
                .expect("Should always fit");
        }
    }
    if let Err(err) = server.set(&server.ossm_service.primary_command, &response_str) {
        error!("Failed to write the response to a set command {:?}", err);
    }
}

pub fn is_ble_connected() -> bool {
    CONNECTED.load(Ordering::Acquire)
}
