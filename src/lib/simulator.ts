// A simulated rig, behind the same transport interface as a real port.
//
// It decodes the frames the app writes and answers with the frames the
// motor-rig firmware would, from a model of a small geared DC motor driving
// a generator whose output the brake shorts. It is there so the app can be
// tried, demonstrated and tested without the hardware -- never mistaken for
// it: the app labels every simulated session as one.
//
// The model is deliberately the shape of the real thing rather than tidy:
// readings carry noise, the load cell publishes at 10 Hz with the odd spike,
// RPM is a 100 ms difference of encoder counts, the bench supply sags under
// load, the load cell reads an offset until it is tared, and opening the port
// restarts the board through its bootloader.

import * as P from "./protocol";
import type { Transport } from "./transport";

const G = 9.80665;
const HX711_LIMIT = 8_388_607;

// A small 6 V gearmotor, fitted to a calibrated sweep of a real one on the
// rig. It runs from a bench supply, not the ERC2's battery, through leads and
// the INA219 shunt that drop about half a volt at stall.
export const MOTOR = {
  nominalV: 6.0,
  noLoadRpm: 120, // at nominalV
  stallTorque: 0.29, // N·m at nominalV
  noLoadA: 0.45,
  stallA: 1.9, // at nominalV
  tau: 0.15, // s, speed time constant
  supplyOhms: 0.3, // leads and shunt, between the supply and the motor
  erc2BatteryV: 11.2, // the controller's own battery, separate from the motor
  // Brake torque per rpm at 100 % duty: slows the motor to about a tenth of
  // its no-load speed with the brake fully on, as the real rig does. The real
  // brake bites far harder near full duty than below it (about half speed at
  // 50 %), which the cube of the duty follows closely.
  brakeNmPerRpm: (0.29 * 0.9) / (0.1 * 120),
  // The load cell's real sensitivity, whatever calibration the rig is told:
  // the firmware's default 390000 counts per unit is right when the unit is
  // kg·cm, as it is here.
  countsPerKgCm: 390000,
  loadOffsetRaw: 1_200_000, // untared reading, about 3 kg·cm
  loadNoiseKgCm: 0.01,
  loadSpikeKgCm: 0.6,
};

function gauss(sd: number): number {
  // Box-Muller; plenty for noise.
  const u = 1 - Math.random();
  const v = Math.random();
  return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Opening the port restarts a real board: the Mega's bootloader, which waits
// for an upload while bytes keep arriving, then the FEH library's start-up,
// printing a line per stage. The simulator does the same, at `bootScale` of
// the real timing, so connecting is exercised the way the hardware needs.
const BOOTLOADER_MS = 900;
const STARTUP_LINES: [number, string][] = [
  [0, "FEH Library initializing..."],
  [1400, "Initializing splash screen..."],
  [1450, "Checking ESP32 firmware version..."],
  [4300, "FEH Library initialized successfully."],
];

export interface SimulatorOptions {
  latencyMs?: number;
  now?: () => number;
  bootScale?: number;
  /** Send VERSION unprompted when ready, as motorrig-1.2 and later do. */
  announce?: boolean;
  /** False holds the start-up waiting for power, as the library does. */
  batteryOn?: boolean;
  /** The baud the simulated library runs at. */
  baud?: number;
  version?: string;
  /** The bench supply's setting. */
  supplyV?: number;
  /** Its current limit, past which its voltage collapses. */
  supplyLimitA?: number;
  /**
   * How often a single INA219 reading comes back far low, as the brake's
   * switching makes the real one do now and then.
   */
  glitchRate?: number;
}

export class SimulatedTransport implements Transport {
  readonly label = "Simulated rig";
  readonly simulated = true;
  baud?: number;
  onData: (bytes: Uint8Array) => void = () => {};
  onClose: (reason: string | null) => void = () => {};

  supplyV: number;
  supplyLimitA: number;
  glitchRate: number;
  latencyMs: number;
  bootScale: number;
  announce: boolean;
  batteryOn: boolean;
  libraryBaud: number;
  version: string;
  private now: () => number;
  private decoder = new P.FrameDecoder();
  private timers: ReturnType<typeof setTimeout>[] = [];
  isOpen = false;
  ready = false;
  inBootloader = false;
  private bootloaderUntil = 0;

  // The rig's state.
  private t = 0;
  motorOn = false;
  brake = 0;
  rpmTrue = 0;
  private countsExact = 0;
  countsPerRev: number = P.DEFAULT_CALIBRATION.countsPerRev;
  countsPerUnit: number = P.DEFAULT_CALIBRATION.countsPerUnit;
  private loadTare = 0;
  private loadRaw = MOTOR.loadOffsetRaw;
  private nextHx = 0;
  private taring = false;
  private tareSamples: number[] = [];
  private rpmReported = 0;
  private lastRpmT = 0;
  private lastRpmCounts = 0;
  torque = 0;
  private current = 0;
  private hungNm = 0;

  constructor({
    latencyMs = 4,
    now = () => performance.now() / 1000,
    bootScale = 0.15,
    announce = true,
    batteryOn = true,
    baud = 500000,
    version = "motorrig-1.3",
    supplyV = MOTOR.nominalV,
    supplyLimitA = 5,
    glitchRate = 0.01,
  }: SimulatorOptions = {}) {
    this.glitchRate = glitchRate;
    this.latencyMs = latencyMs;
    this.now = now;
    this.bootScale = bootScale;
    this.announce = announce;
    this.batteryOn = batteryOn;
    this.libraryBaud = baud;
    this.version = version;
    this.supplyV = supplyV;
    this.supplyLimitA = supplyLimitA;
    this.reset();
  }

  private reset() {
    this.t = this.now();
    this.motorOn = false;
    this.brake = 0;
    this.rpmTrue = 0;
    this.countsExact = 0;
    this.loadTare = 0;
    this.loadRaw = MOTOR.loadOffsetRaw;
    this.nextHx = this.t;
    this.taring = false;
    this.tareSamples = [];
    this.rpmReported = 0;
    this.lastRpmT = this.t;
    this.lastRpmCounts = 0;
    this.torque = 0;
    this.current = 0;
    this.hungNm = 0;
  }

  /** Hang a mass (grams) on the arm at a distance (mm) from the shaft. */
  hang(massG: number, armMm: number) {
    this.hungNm = (massG / 1000) * G * (armMm / 1000);
  }

  /** Turn the generator shaft by hand, `turns` times, with the motor off. */
  turnShaft(turns: number) {
    this.advance();
    this.countsExact += turns * this.countsPerRev;
  }

  async open(baud = this.libraryBaud) {
    // Calibration lives in EEPROM on motorrig-1.3, so it survives this.
    this.reset();
    this.baud = baud;
    this.isOpen = true;
    this.ready = false;
    this.inBootloader = true;
    this.decoder = new P.FrameDecoder();
    this.bootloaderUntil = Date.now() + BOOTLOADER_MS * this.bootScale;
    this.later(BOOTLOADER_MS, () => this.leaveBootloader());
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms * this.bootScale));
  }

  /** The bootloader keeps waiting while anything is arriving. */
  private leaveBootloader() {
    const left = this.bootloaderUntil - Date.now();
    if (left > 0) {
      this.timers.push(setTimeout(() => this.leaveBootloader(), left));
      return;
    }
    this.inBootloader = false;
    const lines = this.batteryOn ? STARTUP_LINES : STARTUP_LINES.slice(0, 1);
    for (const [ms, text] of lines) this.later(ms, () => this.print(`${text}\r\n`));
    if (this.batteryOn) this.later(STARTUP_LINES[STARTUP_LINES.length - 1][0] + 20, () => this.startRig());
  }

  /** Switch the simulated battery on, for a start-up held waiting for power. */
  powerOn() {
    this.batteryOn = true;
    for (const [ms, text] of STARTUP_LINES.slice(1)) this.later(ms - 1400 + 100, () => this.print(`${text}\r\n`));
    this.later(STARTUP_LINES[STARTUP_LINES.length - 1][0] - 1300, () => this.startRig());
  }

  private startRig() {
    this.ready = true;
    if (this.announce) this.send(P.RSP.VERSION, new TextEncoder().encode(this.version));
  }

  private print(text: string) {
    this.emitBytes(new TextEncoder().encode(text));
  }

  /** At the wrong baud, everything arrives as noise, as from a real UART. */
  private emitBytes(bytes: Uint8Array) {
    if (!this.isOpen) return;
    this.onData(this.baud === this.libraryBaud ? bytes : bytes.map((b) => ((b * 37 + 11) & 0xff) | 0x80));
  }

  async close() {
    this.isOpen = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  async write(bytes: Uint8Array) {
    if (!this.isOpen) throw new Error("Port is not open");
    if (this.inBootloader) {
      // Every byte restarts the bootloader's wait for an upload.
      this.bootloaderUntil = Date.now() + BOOTLOADER_MS * this.bootScale;
      return;
    }
    if (!this.ready || this.baud !== this.libraryBaud) return; // nobody listening yet, or garbled
    for (const f of this.decoder.push(bytes)) setTimeout(() => this.handle(f), this.latencyMs);
  }

  /** Replies are not bound by the rig's 50-byte receive buffer. */
  send(rsp: number, payload?: ArrayLike<number>) {
    this.emitBytes(P.frame(rsp, payload));
  }

  // ---- physics -----------------------------------------------------------

  /** The ERC2's own battery, which only runs the controller. */
  private batteryV() {
    return MOTOR.erc2BatteryV + gauss(0.01);
  }

  /** What reaches the motor: the supply, less the leads, unless it is current-limiting. */
  private motorV() {
    const v = this.supplyV - MOTOR.supplyOhms * this.current;
    return this.current > this.supplyLimitA ? v * (this.supplyLimitA / this.current) ** 2 : v;
  }

  private advance() {
    const t = this.now();
    let dt = t - this.t;
    if (dt <= 0) return;
    this.t = t;

    // Integrate in small steps so a long gap between requests stays stable.
    while (dt > 0) {
      const h = Math.min(dt, 0.01);
      dt -= h;
      const scale = this.motorV() / MOTOR.nominalV;
      const n0 = MOTOR.noLoadRpm * scale;
      const ts = MOTOR.stallTorque * scale;
      const c = MOTOR.brakeNmPerRpm * (this.brake / 100) ** 3;
      const target = this.motorOn ? ts / (ts / n0 + c) : 0;
      this.rpmTrue += ((target - this.rpmTrue) * h) / MOTOR.tau;
      if (this.rpmTrue < 0) this.rpmTrue = 0;
      this.torque = c * this.rpmTrue;
      this.current = this.motorOn ? MOTOR.noLoadA + (MOTOR.stallA * scale - MOTOR.noLoadA) * (this.torque / ts) : 0;
      this.countsExact += (this.rpmTrue / 60) * this.countsPerRev * h;
    }

    // The HX711 publishes at about 10 Hz.
    while (this.nextHx <= t) {
      this.nextHx += 0.1;
      const kgCm = ((this.torque + this.hungNm) / G) * 100;
      let noise = gauss(MOTOR.loadNoiseKgCm);
      if (Math.random() < 0.015) noise += (Math.random() < 0.5 ? -1 : 1) * MOTOR.loadSpikeKgCm; // spike
      const raw = Math.round(MOTOR.loadOffsetRaw + (kgCm + noise) * MOTOR.countsPerKgCm);
      this.loadRaw = Math.max(-HX711_LIMIT - 1, Math.min(HX711_LIMIT, raw)); // a 24-bit converter
      if (this.taring) {
        // As motorrig-1.3 does: the mean of the middle half of 16 readings.
        this.tareSamples.push(this.loadRaw);
        if (this.tareSamples.length >= 16) {
          const mid = [...this.tareSamples].sort((a, b) => a - b).slice(4, 12);
          this.loadTare = Math.round(mid.reduce((a, v) => a + v, 0) / mid.length);
          this.tareSamples = [];
          this.taring = false;
        }
      }
    }

    // RPM as the firmware computes it: counts over a 100 ms window.
    if (t - this.lastRpmT >= 0.1) {
      const counts = Math.round(this.countsExact);
      this.rpmReported = (Math.abs(counts - this.lastRpmCounts) / this.countsPerRev) * (60 / (t - this.lastRpmT));
      this.lastRpmCounts = counts;
      this.lastRpmT = t;
    }
  }

  // ---- protocol ------------------------------------------------------------

  statusPayload(): Uint8Array {
    this.advance();
    const out = new Uint8Array(P.STATUS_BYTES);
    const v = new DataView(out.buffer);
    const f = (o: number, x: number) => v.setFloat32(o, x, true);
    out[0] = (this.motorOn ? 0x01 : 0) | 0x02 | 0x04 | 0x08 | (this.taring ? 0x10 : 0);
    out[1] = this.brake;
    const iTest = this.current * 1000 + (this.motorOn ? gauss(15) : gauss(0.5));
    // On the supply side of the switch, so it reads the supply even with the
    // motor off.
    let vTest = this.motorV() + gauss(0.004);
    if (Math.random() < this.glitchRate) vTest *= 0.75 + Math.random() * 0.05; // one bad reading
    f(2, iTest);
    f(6, vTest);
    f(10, iTest * vTest);
    const genV = this.rpmTrue * 0.048 * (1 - this.brake / 100);
    const genI = (this.torque / MOTOR.stallTorque) * 900 * (this.brake / 100) + gauss(5);
    f(14, genI);
    f(18, genV);
    f(22, genI * genV);
    const net = this.loadRaw - this.loadTare;
    f(26, net / this.countsPerUnit);
    v.setInt32(30, net, true);
    f(34, this.rpmReported);
    v.setInt32(38, Math.round(this.countsExact) & 0xffff, true); // the library's 16-bit counter
    f(42, this.batteryV());
    f(46, this.countsPerRev);
    f(50, this.countsPerUnit);
    return out;
  }

  handle({ cmd, payload }: P.Frame) {
    switch (cmd) {
      case P.CMD.PING:
        return this.send(P.RSP.PONG);
      case P.CMD.VERSION:
        return this.send(P.RSP.VERSION, new TextEncoder().encode(this.version));
      case P.CMD.RIG_STATUS:
        return this.send(P.RSP.RIG_STATUS, this.statusPayload());
      case P.CMD.RIG_MOTOR:
        if (payload.length < 1) return;
        this.advance();
        this.motorOn = payload[0] !== 0;
        return this.send(P.RSP.RIG_STATUS, this.statusPayload());
      case P.CMD.RIG_BRAKE:
        if (payload.length < 1) return;
        this.advance();
        this.brake = Math.min(100, payload[0]);
        return this.send(P.RSP.RIG_STATUS, this.statusPayload());
      case P.CMD.RIG_TARE:
        this.advance();
        this.taring = true;
        this.tareSamples = [];
        return;
      case P.CMD.RIG_RESET_ENC:
        this.advance();
        this.countsExact = 0;
        this.lastRpmCounts = 0;
        this.rpmReported = 0;
        return;
      case P.CMD.RIG_ESTOP:
        this.advance();
        this.motorOn = false;
        this.brake = 0;
        return this.send(P.RSP.RIG_STATUS, this.statusPayload());
      case P.CMD.RIG_I2C_SCAN:
        return this.send(P.RSP.RIG_I2C, Uint8Array.from([2, 0x40, 0x41]));
      case P.CMD.RIG_SET_CAL: {
        if (payload.length < 8) return;
        const v = new DataView(payload.buffer, payload.byteOffset, 8);
        const cpr = v.getFloat32(0, true);
        const cpu = v.getFloat32(4, true);
        if (cpr > 0) this.countsPerRev = cpr;
        if (cpu !== 0) this.countsPerUnit = cpu;
        return this.send(P.RSP.RIG_STATUS, this.statusPayload());
      }
    }
  }
}
