// Talking to one rig over a transport: identifying it, sending its commands,
// and keeping its status coming.

import * as P from "./protocol";
import type { RigStatus } from "./protocol";
import type { Transport } from "./transport";

// Opening the port resets the Mega, and what happens next decides how to
// connect. The bootloader runs first and waits for an upload for as long as
// bytes keep arriving -- so a host that starts asking straight away keeps
// the board in its bootloader forever. Then the FEH library starts up,
// printing a line per stage, which takes about five seconds, or forever if
// the battery is off: it waits for power. Only then does the rig's own code
// run. So the client says nothing until the rig announces itself
// (motorrig-1.2 and later), or the library says it is done (older rigs).
export const BOOT = {
  stepMs: 100,
  // Nothing at all after opening: the board did not reset, or prints at
  // another baud. Past the bootloader by now, so asking is safe.
  silentMs: 2500,
  // "initialized successfully", then quiet: ERCMain is running.
  readyQuietMs: 300,
  // Still on the first line after this long: the library is waiting for
  // battery power, which it does before anything else.
  powerHintMs: 1500,
  // A normal start-up, and the longest wait for the battery to come on.
  startupMs: 20000,
  powerWaitMs: 120000,
  probes: 6,
  probeMs: 350,
};
export type BootTiming = typeof BOOT;

const STATUS_TIMEOUT_MS = 1500;
export const POLL_HZ = 10;

export type ConnectPhase = "restarting" | "starting" | "waiting-power" | "identifying";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the board has printed since the port opened. */
class BootWatch {
  openedAt = Date.now();
  lastByteAt = 0;
  total = 0;
  printable = 0;
  text = "";
  hello: string | null = null;
  agent = false;

  feed(bytes: Uint8Array) {
    this.lastByteAt = Date.now();
    this.total += bytes.length;
    let chunk = "";
    for (const b of bytes) {
      if ((b >= 32 && b < 127) || b === 10 || b === 13 || b === 9) {
        this.printable++;
        chunk += String.fromCharCode(b);
      }
    }
    this.text = (this.text + chunk).slice(-2000);
  }

  get sawInit() {
    return /FEH Library initializing/i.test(this.text);
  }

  get sawReady() {
    return /initialized successfully/i.test(this.text);
  }

  /** Only the first line so far: the library is still waiting for power. */
  get onFirstLine() {
    return this.sawInit && !/splash|ESP32|initialized/i.test(this.text);
  }

  /** Bytes, but not text: the board is talking at another baud. */
  get garbled() {
    return this.total >= 24 && this.printable / this.total < 0.7;
  }

  quietFor() {
    return Date.now() - (this.lastByteAt || this.openedAt);
  }
}

const AGENT = Symbol("erc2-agent");

interface Events {
  status: RigStatus;
  i2c: number[];
  close: string | null;
}

interface Waiter {
  rsp: number;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ConnectOptions {
  onProgress?: (phase: ConnectPhase, baud: number) => void;
  bauds?: readonly number[];
  timing?: Partial<BootTiming>;
}

export class RigClient {
  version: string | null = null;
  status: RigStatus | null = null;
  closed = false;
  private decoder = new P.FrameDecoder();
  private listeners: { [K in keyof Events]: ((v: Events[K]) => void)[] } = { status: [], i2c: [], close: [] };
  private waiters: Waiter[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollPaused = false;
  private boot: BootWatch | null = null;

  constructor(readonly transport: Transport) {
    transport.onData = (bytes) => {
      this.boot?.feed(bytes);
      for (const f of this.decoder.push(bytes)) this.dispatch(f);
    };
    transport.onClose = (reason) => this.handleClose(reason);
  }

  get simulated(): boolean {
    return !!this.transport.simulated;
  }

  on<K extends keyof Events>(event: K, fn: (v: Events[K]) => void): () => void {
    (this.listeners[event] as ((v: Events[K]) => void)[]).push(fn);
    return () => {
      this.listeners[event] = (this.listeners[event] as ((v: Events[K]) => void)[]).filter((f) => f !== fn) as never;
    };
  }

  private emit<K extends keyof Events>(event: K, value: Events[K]) {
    for (const fn of this.listeners[event] as ((v: Events[K]) => void)[]) fn(value);
  }

  private dispatch({ cmd, payload }: P.Frame) {
    if (this.boot && P.ERC2_AGENT_REPLIES.has(cmd)) this.boot.agent = true;
    if (this.boot && cmd === P.RSP.VERSION) this.boot.hello = P.parseVersion(payload);
    let value: unknown = payload;
    if (cmd === P.RSP.RIG_STATUS) {
      const status = P.parseStatus(payload);
      if (!status) return;
      this.status = status;
      this.emit("status", status);
      value = status;
    } else if (cmd === P.RSP.RIG_I2C) {
      const found = P.parseI2c(payload);
      this.emit("i2c", found);
      value = found;
    } else if (cmd === P.RSP.VERSION) {
      value = P.parseVersion(payload);
    }
    const waiting = this.waiters.filter((w) => w.rsp === cmd);
    this.waiters = this.waiters.filter((w) => w.rsp !== cmd);
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.resolve(value);
    }
  }

  /** The next frame of type `rsp`, or null after `timeoutMs`. */
  private next<T>(rsp: number, timeoutMs: number): Promise<T | null> {
    return new Promise((resolve) => {
      const w: Waiter = {
        rsp,
        resolve: resolve as (v: unknown) => void,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  async send(cmd: number, payload?: ArrayLike<number>): Promise<void> {
    if (this.closed) throw new Error("The rig is disconnected");
    await this.transport.write(P.encode(cmd, payload));
  }

  /**
   * Open the port and make sure a rig is on the other end, trying each baud
   * the rig firmware has used. Throws with a message for the operator when
   * it cannot connect.
   */
  async connect({ onProgress = () => {}, bauds = P.BAUDS, timing = {} }: ConnectOptions = {}): Promise<string> {
    const t = { ...BOOT, ...timing };
    let heard = false;
    let started = false;
    for (const [i, baud] of bauds.entries()) {
      if (i > 0) {
        await this.transport.close();
        this.decoder = new P.FrameDecoder();
      }
      const found = await this.identify(baud, onProgress, t);
      heard = heard || (this.boot?.total ?? 0) > 0;
      started = started || !!this.boot?.sawReady;
      if (found === AGENT) {
        await this.close();
        throw new Error(
          "This board is running an ordinary ERC2 program, not the motor-rig firmware. " +
            "Upload apps/motor-rig to it, then connect again.",
        );
      }
      if (found && !P.isRigVersion(found)) {
        await this.close();
        throw new Error(`This board is running "${found}", not the motor-rig firmware.`);
      }
      if (found) {
        this.boot = null;
        this.version = found;
        // Have numbers on screen before the first poll comes round.
        await this.requestStatus();
        this.startPolling();
        return found;
      }
      if (this.closed) break;
    }
    await this.close();
    throw new Error(
      !heard
        ? "Nothing at all came from the board. Check the USB cable, and that no other program " +
            "(a Serial Monitor, ERC2 Link, another browser tab) has the port open."
        : started
          ? "The board started up, but the motor-rig firmware didn't answer. Upload apps/motor-rig to it."
          : "The board didn't finish starting up. Check its battery is on, then connect again.",
    );
  }

  /** One baud: wait out the board's start-up, then find out what it runs. */
  private async identify(
    baud: number,
    onProgress: (phase: ConnectPhase, baud: number) => void,
    t: BootTiming,
  ): Promise<string | typeof AGENT | null> {
    const boot = (this.boot = new BootWatch());
    await this.transport.open(baud);
    boot.openedAt = Date.now();
    let phase: ConnectPhase | null = null;
    const say = (p: ConnectPhase) => {
      if (p !== phase) onProgress((phase = p), baud);
    };
    say("restarting");

    for (;;) {
      await sleep(t.stepMs);
      if (this.closed) return null;
      if (boot.hello) return boot.hello; // motorrig-1.2+: it says when it is ready
      if (boot.agent) return AGENT;
      if (boot.garbled) return null; // another baud
      const elapsed = Date.now() - boot.openedAt;
      if (boot.sawReady) {
        if (boot.quietFor() > t.readyQuietMs) break; // an older rig: ask
        say("starting");
      } else if (boot.sawInit) {
        const waitingForPower = boot.onFirstLine && boot.quietFor() > t.powerHintMs;
        say(waitingForPower ? "waiting-power" : "starting");
        if (elapsed > (waitingForPower ? t.powerWaitMs : t.startupMs)) return null;
      } else if (boot.quietFor() > t.silentMs) {
        break; // no start-up text: maybe no reset happened; past the bootloader, so ask
      }
    }

    say("identifying");
    for (let i = 0; i < t.probes; i++) {
      const reply = this.next<string>(P.RSP.VERSION, t.probeMs);
      await this.send(P.CMD.VERSION);
      const version = await reply;
      if (version != null) return version;
      if (boot.agent) return AGENT;
      if (boot.garbled || this.closed) return null;
    }
    return null;
  }

  /** Ask for one status frame and wait for it; null if none arrives in time. */
  async requestStatus(timeoutMs = STATUS_TIMEOUT_MS): Promise<RigStatus | null> {
    const reply = this.next<RigStatus>(P.RSP.RIG_STATUS, timeoutMs);
    await this.send(P.CMD.RIG_STATUS);
    return reply;
  }

  private startPolling() {
    this.stopPolling();
    let busy = false;
    this.pollTimer = setInterval(async () => {
      if (this.pollPaused || busy || this.closed) return;
      busy = true;
      try {
        await this.requestStatus();
      } catch {
        // A failed write means the port went; handleClose says so.
      } finally {
        busy = false;
      }
    }, 1000 / POLL_HZ);
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** A sweep requests its own frames at its own rate; the poll steps aside. */
  pausePolling(paused: boolean) {
    this.pollPaused = paused;
  }

  setMotor(on: boolean) {
    return this.send(P.CMD.RIG_MOTOR, [on ? 1 : 0]);
  }

  setBrake(duty: number) {
    return this.send(P.CMD.RIG_BRAKE, [Math.max(0, Math.min(100, Math.round(duty)))]);
  }

  tare() {
    return this.send(P.CMD.RIG_TARE);
  }

  resetEncoder() {
    return this.send(P.CMD.RIG_RESET_ENC);
  }

  estop() {
    return this.send(P.CMD.RIG_ESTOP);
  }

  async scanI2c(): Promise<number[] | null> {
    const reply = this.next<number[]>(P.RSP.RIG_I2C, 3000);
    await this.send(P.CMD.RIG_I2C_SCAN);
    return reply;
  }

  setCalibration(countsPerRev: number, countsPerUnit: number) {
    return this.send(P.CMD.RIG_SET_CAL, P.calibrationPayload(countsPerRev, countsPerUnit));
  }

  private failWaiters() {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiters = [];
  }

  private handleClose(reason: string | null) {
    if (this.closed) return;
    this.closed = true;
    this.stopPolling();
    this.failWaiters();
    this.emit("close", reason);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.stopPolling();
    this.closed = true;
    this.failWaiters();
    await this.transport.close();
    this.emit("close", null);
  }
}
