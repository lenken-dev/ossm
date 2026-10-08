import { useEffect, useRef, useState } from "react";

// OSSM BLE remote of the ossm-rs firmware (crates/ble-remote/src/lib.rs).
const uuid = (id: string) => `522b443a-4f53-534d-${id}-420badbabe69`;
const SERVICE = uuid("0001");
const COMMAND = uuid("1000");
const STATE = uuid("2000");
const PATTERN_LIST = uuid("3000");
const PATTERN_DESCRIPTION = uuid("3010");
const STREAM_LOOKAHEAD = uuid("5000");

/** Pending writes above which the queue warns. */
const QUEUE_WARN = 10;

export const UNSUPPORTED_FIRMWARE = "Unsupported firmware: this player needs the ossm-rs firmware";

export type DeviceState = "idle" | "homing" | "ready" | "playing" | "paused" | "streaming";

/** The state characteristic's JSON. Settings are 0–100. */
export interface OssmState {
  state: DeviceState;
  speed: number;
  stroke: number;
  sensation: number;
  depth: number;
  pattern: number;
  patternName: string;
}

export interface PatternInfo {
  name: string;
  idx: number;
}

/** Log a `[player]` line stamped with `performance.now()`. */
export function log(message: string, level: "log" | "warn" | "error" = "log") {
  console[level](`[player] t=${performance.now().toFixed(1)} ${message}`);
}

interface Job {
  /** Coalescing key of a setting write (`set:speed:`); its text is replaced while pending. */
  key?: string;
  text: string;
  /** Appended to the write's log line. */
  note?: string;
  queued: number;
  run: (job: Job) => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const decode = (value: DataView) => decoder.decode(value);

/**
 * A connection to an OSSM running the ossm-rs firmware. All GATT operations
 * run one at a time through a queue, since Web Bluetooth rejects concurrent
 * ones.
 */
export class Ossm {
  /** Last state read or notified. */
  state: OssmState | null = null;
  private stateText = "";
  private queue: Job[] = [];
  private busy = false;
  private userDisconnect = false;
  private stateListeners = new Set<(state: OssmState) => void>();
  private disconnectListeners = new Set<() => void>();

  private constructor(
    readonly device: BluetoothDevice,
    /** Points the player may send beyond the one the machine is heading to; `0` cannot stream. */
    readonly lookahead: number,
    private commandChar: BluetoothRemoteGATTCharacteristic,
    private stateChar: BluetoothRemoteGATTCharacteristic,
    private patternListChar: BluetoothRemoteGATTCharacteristic,
    private patternDescriptionChar: BluetoothRemoteGATTCharacteristic,
  ) {
    device.addEventListener("gattserverdisconnected", this.handleDisconnected);
    stateChar.addEventListener("characteristicvaluechanged", () => {
      if (stateChar.value) this.handleState(decode(stateChar.value));
    });
  }

  /**
   * Ask the user for a device and connect to it. Resolves to `null` when the
   * user cancels the chooser. Rejects with {@link UNSUPPORTED_FIRMWARE} when
   * the device has no stream look-ahead characteristic.
   */
  static async connect(): Promise<Ossm | null> {
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") return null;
      throw e;
    }
    const server = await device.gatt!.connect();
    try {
      const service = await server.getPrimaryService(SERVICE);
      let lookaheadChar: BluetoothRemoteGATTCharacteristic;
      try {
        lookaheadChar = await service.getCharacteristic(STREAM_LOOKAHEAD);
      } catch (e) {
        if (e instanceof DOMException && e.name === "NotFoundError") throw new Error(UNSUPPORTED_FIRMWARE);
        throw e;
      }
      const lookahead = Number(decode(await lookaheadChar.readValue())) || 0;
      const ossm = new Ossm(
        device,
        lookahead,
        await service.getCharacteristic(COMMAND),
        await service.getCharacteristic(STATE),
        await service.getCharacteristic(PATTERN_LIST),
        await service.getCharacteristic(PATTERN_DESCRIPTION),
      );
      log(`connected to ${device.name ?? device.id}`);
      log(`look-ahead ${lookahead}`);
      ossm.handleState(decode(await ossm.stateChar.readValue()));
      await ossm.stateChar.startNotifications();
      return ossm;
    } catch (e) {
      server.disconnect();
      throw e;
    }
  }

  get name() {
    return this.device.name ?? this.device.id;
  }

  disconnect() {
    this.userDisconnect = true;
    this.device.gatt?.disconnect();
  }

  /** Subscribe to state notifications; returns the unsubscribe function. */
  onState(listener: (state: OssmState) => void) {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  }

  /** Called once the connection is gone, whoever ended it. */
  onDisconnect(listener: () => void) {
    this.disconnectListeners.add(listener);
    return () => void this.disconnectListeners.delete(listener);
  }

  /**
   * Write a command with response, then read and log the reply. Resolves to
   * the reply (`ok:<cmd>` / `fail:<cmd>`), or `undefined` when the write
   * failed. Pending writes of the same setting (`set:<name>:`) are coalesced:
   * the latest value wins and its callers share the result. `note` is
   * appended to the write's log line.
   */
  command(text: string, note?: string): Promise<string | undefined> {
    const key = text.match(/^set:[^:]+:/)?.[0];
    const pending = key && this.queue.find((job) => job.key === key);
    if (pending) {
      pending.text = text;
      return pending.promise as Promise<string | undefined>;
    }
    return this.enqueue({ text, key, note }, async (job) => {
      if (!(await this.write(job, true))) return undefined;
      const reply = decode(await this.commandChar.readValue());
      log(`← ${reply}`, reply.startsWith("fail:") ? "warn" : "log");
      return reply;
    }).catch(() => undefined);
  }

  /**
   * Stream a point (`stream:<position>:<duration ms>`) without response.
   * Position is 0 (deep) to 100 (shallow). Resolves to whether it was written.
   * `note` is appended to the write's log line.
   */
  streamPoint(position: number, durationMs: number, note?: string): Promise<boolean> {
    const text = `stream:${Math.round(position * 10) / 10}:${Math.round(durationMs)}`;
    return this.enqueue({ text, note }, (job) => this.write(job, false)).catch(() => false);
  }

  readPatterns(): Promise<PatternInfo[]> {
    return this.enqueue({ text: "read patterns" }, async () =>
      JSON.parse(decode(await this.patternListChar.readValue())) as PatternInfo[],
    );
  }

  readDescription(idx: number): Promise<string> {
    return this.enqueue({ text: `read description ${idx}` }, async () => {
      await this.patternDescriptionChar.writeValueWithResponse(encoder.encode(String(idx)));
      return decode(await this.patternDescriptionChar.readValue());
    });
  }

  private enqueue<T>(
    job: Pick<Job, "text" | "key" | "note">,
    run: (job: Job) => Promise<T>,
  ): Promise<T> {
    let resolve!: Job["resolve"];
    let reject!: Job["reject"];
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.queue.push({ ...job, queued: performance.now(), run, promise, resolve, reject });
    if (this.queue.length > QUEUE_WARN) log(`write queue: ${this.queue.length} pending`, "warn");
    void this.pump();
    return promise as Promise<T>;
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      try {
        job.resolve(await job.run(job));
      } catch (e) {
        job.reject(e);
      }
    }
    this.busy = false;
  }

  /** Write a command and log it; returns whether it went out. */
  private async write(job: Job, withResponse: boolean) {
    const start = performance.now();
    const data = encoder.encode(job.text);
    try {
      await (withResponse
        ? this.commandChar.writeValueWithResponse(data)
        : this.commandChar.writeValueWithoutResponse(data));
    } catch (e) {
      log(`→ ${job.text} failed: ${e}`, "error");
      return false;
    }
    const end = performance.now();
    const note = job.note ? ` ${job.note}` : "";
    log(`→ ${job.text}${note} (queued ${(start - job.queued).toFixed(1)} ms, write ${(end - start).toFixed(1)} ms)`);
    return true;
  }

  private handleState(text: string) {
    if (text === this.stateText) return;
    this.stateText = text;
    try {
      this.state = JSON.parse(text) as OssmState;
    } catch {
      log(`unparsable state ${text}`, "warn");
      return;
    }
    log(`← state ${text}`);
    for (const listener of this.stateListeners) listener(this.state);
  }

  private handleDisconnected = () => {
    this.device.removeEventListener("gattserverdisconnected", this.handleDisconnected);
    log(`disconnected by the ${this.userDisconnect ? "user" : "device"}`);
    for (const job of this.queue.splice(0)) job.reject(new Error("Disconnected"));
    for (const listener of this.disconnectListeners) listener();
  };
}

/**
 * The page's connection: connects on demand, follows the device state, and
 * disconnects on unmount.
 */
export function useOssm() {
  const [ossm, setOssm] = useState<Ossm | null>(null);
  const [state, setState] = useState<OssmState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ossmRef = useRef<Ossm | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ossmRef.current?.disconnect();
    };
  }, []);

  const connect = async () => {
    setError(null);
    setConnecting(true);
    try {
      const next = await Ossm.connect();
      if (!next) return;
      if (!mounted.current) {
        next.disconnect();
        return;
      }
      ossmRef.current = next;
      next.onState(setState);
      next.onDisconnect(() => {
        ossmRef.current = null;
        setOssm(null);
        setState(null);
      });
      setState(next.state);
      setOssm(next);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`connect failed: ${message}`, "error");
      setError(message);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => ossmRef.current?.disconnect();

  return { ossm, state, connecting, error, connect, disconnect };
}
