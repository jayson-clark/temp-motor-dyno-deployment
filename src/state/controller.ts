// Everything the app does, outside React: the connection, the rig's live
// readings, driving it by hand, sweeps, results and calibration. The UI reads
// a snapshot of this and calls its methods; nothing here knows about the DOM
// beyond the clock it batches updates on, so it runs the same under a test.

import { DEFAULT_CALIBRATION, type RigStatus } from "../lib/protocol";
import { RigClient, type ConnectPhase } from "../lib/rig";
import { SimulatedTransport } from "../lib/simulator";
import { median } from "../lib/stats";
import {
  curveCsv,
  csv,
  DEFAULT_PARAMS,
  grade,
  headline,
  mergeParams,
  rawCsv,
  SweepRunner,
  type Calibration,
  type Headline,
  type Sample,
  type Step,
  type SweepParams,
  type SweepResult,
  type SweepState,
} from "../lib/sweep";
import { choosePort, grantedPorts, webSerialSupported, WebSerialTransport, type Transport } from "../lib/transport";
import { download, load, save } from "./storage";

export const LIVE_SECONDS = 30;
// The rig panel's numbers are the median of this long of readings: steady
// enough to read, quick enough to follow a change, and immune to the odd
// glitched reading that a plain average would still show.
export const SMOOTH_SECONDS = 1;
// The rig answers every brake command with a status frame, so a slider
// dragged at 60 Hz would flood the link. Writes are coalesced to one per
// interval, always flushing the last value so the brake ends up exactly
// where it was let go.
const BRAKE_WRITE_MS = 100;
// After the slider is let go, keep showing what was asked for until the
// rig's own reports have had time to catch up.
const BRAKE_ADOPT_AFTER_MS = 600;
// The rig tares from 16 load-cell readings: about 1.6 s at the HX711's
// 10 Hz. Much longer than that and the readings have stopped coming.
export const TARE_TIMEOUT_MS = 6000;

export interface Connection {
  state: "disconnected" | "connecting" | "connected";
  phase: ConnectPhase | null;
  baud: number | null;
  label: string | null;
  version: string | null;
  simulated: boolean;
}

export interface ResultRow extends Headline {
  id: string;
  motor: string;
  started: string;
  status: "Complete" | "Stalled" | "Cancelled" | "Aborted";
  calibration: Calibration | null;
}

export interface RunView {
  running: boolean;
  state: SweepState | null;
  steps: Step[];
  /** Measure-phase samples, for the raw scatter. */
  samples: Sample[];
  result: SweepResult | null;
  log: string[];
}

/** The rig panel's readings, each the median of the last second; null when there are none. */
export interface Smoothed {
  rpm: number | null;
  currentA: number | null;
  supplyV: number | null;
  powerW: number | null;
  load: number | null;
  genV: number | null;
  genA: number | null;
  batteryV: number | null;
}

export interface AppState {
  supported: boolean;
  connection: Connection;
  banner: string | null;
  status: RigStatus | null;
  /** [seconds, rpm, amps], the last LIVE_SECONDS of readings. */
  live: [number, number, number][];
  smoothed: Smoothed | null;
  brake: number;
  params: SweepParams;
  run: RunView;
  results: ResultRow[];
  refId: string | null;
  autoDownload: boolean;
  i2c: number[] | null;
  calibrationNote: string | null;
}

const DISCONNECTED: Connection = {
  state: "disconnected",
  phase: null,
  baud: null,
  label: null,
  version: null,
  simulated: false,
};

const EMPTY_RUN: RunView = { running: false, state: null, steps: [], samples: [], result: null, log: [] };

/** Still on the firmware's defaults: never calibrated, or an old rig that restarted. */
export function onDefaultCalibration(s: RigStatus | null): boolean {
  return (
    !!s &&
    s.countsPerRev !== null &&
    s.countsPerUnit !== null &&
    Math.abs(s.countsPerRev - DEFAULT_CALIBRATION.countsPerRev) < 1e-3 &&
    Math.abs(s.countsPerUnit / DEFAULT_CALIBRATION.countsPerUnit - 1) < 1e-6
  );
}

function friendlyError(err: unknown): string {
  const e = err as Error;
  if (e?.name === "InvalidStateError") return "That port is already open, maybe in another tab.";
  if (e?.name === "NetworkError" || /Failed to open/i.test(e?.message ?? ""))
    return "Couldn't open the port. Close any Serial Monitor, ERC2 Link or other tab using it, then try again.";
  return e?.message ?? String(err);
}

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function safeName(text: string): string {
  return text.trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
}

type Listener = () => void;

export class Controller {
  private state: AppState;
  private listeners = new Set<Listener>();
  private notifyPending = false;
  private rig: RigClient | null = null;
  private runner: SweepRunner | null = null;
  private userClosing = false;
  private brakePending: number | null = null;
  private brakeTimer: ReturnType<typeof setTimeout> | null = null;
  private brakeHoldUntil = 0;
  private recent: [number, RigStatus][] = [];

  constructor() {
    this.state = {
      supported: webSerialSupported(),
      connection: DISCONNECTED,
      banner: null,
      status: null,
      live: [],
      smoothed: null,
      brake: 0,
      params: mergeParams(load("params", {})),
      run: EMPTY_RUN,
      results: load<ResultRow[]>("results", []),
      refId: load<string | null>("refId", null),
      autoDownload: load("autoDownload", true),
      i2c: null,
      calibrationNote: null,
    };
  }

  // ---- store --------------------------------------------------------------

  getState = (): AppState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /**
   * Readings arrive at up to 50 Hz in a sweep; the UI redraws at most once a
   * frame. A timer backs the frame up: browsers stop animation frames in a
   * background tab, and the page should still be current when it comes back.
   */
  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    if (this.notifyPending) return;
    this.notifyPending = true;
    let done = false;
    const flush = () => {
      if (done) return;
      done = true;
      this.notifyPending = false;
      for (const fn of this.listeners) fn();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    setTimeout(flush, 50);
  }

  private setRun(patch: Partial<RunView>) {
    this.set({ run: { ...this.state.run, ...patch } });
  }

  get connected(): boolean {
    return !!this.rig && !this.rig.closed;
  }

  dismissBanner() {
    this.set({ banner: null });
  }

  showBanner(message: string) {
    this.set({ banner: message });
  }

  // ---- connecting -------------------------------------------------------------

  private async connectWith(transport: Transport, { quiet = false } = {}): Promise<boolean> {
    if (this.state.connection.state !== "disconnected") return false;
    this.set({
      connection: { ...DISCONNECTED, state: "connecting", phase: "restarting", label: transport.label, simulated: !!transport.simulated },
      banner: null,
    });
    const rig = new RigClient(transport);
    try {
      await rig.connect({
        onProgress: (phase, baud) => this.set({ connection: { ...this.state.connection, phase, baud } }),
      });
    } catch (err) {
      this.set({ connection: DISCONNECTED, banner: quiet ? this.state.banner : friendlyError(err) });
      return false;
    }
    this.rig = rig;
    this.recent = [];
    rig.on("status", (s) => this.onStatus(s));
    rig.on("i2c", (found) => this.set({ i2c: found }));
    rig.on("close", (reason) => this.onClose(rig, reason));
    this.set({
      connection: {
        state: "connected",
        phase: null,
        baud: transport.baud ?? null,
        label: transport.label,
        version: rig.version,
        simulated: rig.simulated,
      },
      live: [],
      smoothed: null,
      i2c: null,
    });
    if (rig.status) this.onStatus(rig.status);
    await this.syncCalibrationOnConnect();
    return true;
  }

  /** Try each port this page was given before; quietly, since most are not rigs. */
  async autoConnect(): Promise<void> {
    for (const port of await grantedPorts()) {
      if (this.connected) return;
      if (await this.connectWith(new WebSerialTransport(port), { quiet: true })) return;
    }
  }

  /** A port this page already knows was plugged in. */
  async portPlugged(port: SerialPort): Promise<void> {
    if (!this.connected) await this.connectWith(new WebSerialTransport(port), { quiet: true });
  }

  async chooseAndConnect(allPorts = false): Promise<void> {
    this.set({ banner: null });
    let port: SerialPort | null;
    try {
      port = await choosePort(allPorts);
    } catch (err) {
      this.set({ banner: friendlyError(err) });
      return;
    }
    if (port) await this.connectWith(new WebSerialTransport(port));
  }

  async connectSimulated(): Promise<void> {
    await this.connectWith(new SimulatedTransport());
  }

  async disconnect(): Promise<void> {
    if (!this.rig) return;
    this.userClosing = true;
    this.runner?.cancel();
    try {
      await this.rig.estop();
    } catch {
      /* already gone */
    }
    await this.rig.close();
  }

  private onClose(rig: RigClient, reason: string | null) {
    if (this.rig !== rig) return;
    const expected = this.userClosing;
    this.userClosing = false;
    this.rig = null;
    this.recent = [];
    this.runner?.cancel();
    this.set({
      connection: DISCONNECTED,
      status: null,
      live: [],
      smoothed: null,
      banner: expected
        ? this.state.banner
        : `Lost the rig${reason ? ` (${reason})` : ""}. Check the USB cable; it reconnects by itself when plugged back in.`,
    });
  }

  // ---- live readings ------------------------------------------------------------

  private onStatus(s: RigStatus) {
    const t = performance.now() / 1000;
    this.recent.push([t, s]);
    while (this.recent.length && this.recent[0][0] < t - SMOOTH_SECONDS) this.recent.shift();
    const smoothed = this.smooth();
    const live = [...this.state.live, [t, s.rpm, s.inaTestOk ? s.test.currentMa / 1000 : NaN] as [number, number, number]];
    while (live.length && live[0][0] < t - LIVE_SECONDS) live.shift();
    // Adopt the rig's brake unless someone is driving it right now.
    const brake = this.brakePending === null && performance.now() > this.brakeHoldUntil ? s.brake : this.state.brake;
    this.set({ status: s, live, brake, smoothed });
  }

  private smooth(): Smoothed {
    const of = (pick: (s: RigStatus) => number | null) => {
      const values = this.recent.map(([, s]) => pick(s)).filter((v): v is number => v !== null && Number.isFinite(v));
      return values.length ? median(values) : null;
    };
    return {
      rpm: of((s) => s.rpm),
      currentA: of((s) => (s.inaTestOk ? s.test.currentMa / 1000 : null)),
      supplyV: of((s) => (s.inaTestOk ? s.test.voltageV : null)),
      powerW: of((s) => (s.inaTestOk ? s.test.powerMw / 1000 : null)),
      // Readings taken mid-tare are against the old zero.
      load: of((s) => (s.loadValid && !s.taring ? s.load : null)),
      genV: of((s) => (s.inaGenOk ? s.gen.voltageV : null)),
      genA: of((s) => (s.inaGenOk ? s.gen.currentMa / 1000 : null)),
      batteryV: of((s) => s.batteryV),
    };
  }

  // ---- driving it by hand ------------------------------------------------------------

  /** E-STOP: never gated on anything. */
  async estop(): Promise<void> {
    if (!this.rig) return;
    // Cancel first: a sweep mid-step would otherwise put the brake back.
    this.runner?.cancel();
    this.brakePending = null;
    this.set({ brake: 0 });
    try {
      await this.rig.estop();
    } catch (err) {
      this.set({ banner: `E-STOP could not be sent: ${friendlyError(err)}. Switch the rig's power off.` });
    }
  }

  async setMotor(on: boolean): Promise<void> {
    if (this.connected && !this.runner) await this.rig!.setMotor(on);
  }

  pushBrake(value: number) {
    if (!this.connected || this.runner) return;
    value = Math.max(0, Math.min(100, Math.round(value)));
    this.brakePending = value;
    this.brakeHoldUntil = performance.now() + BRAKE_ADOPT_AFTER_MS;
    this.set({ brake: value });
    if (!this.brakeTimer) void this.flushBrake();
  }

  /** Send the latest value, then look again in BRAKE_WRITE_MS for a newer one. */
  private async flushBrake() {
    const v = this.brakePending;
    this.brakePending = null;
    if (v === null) {
      this.brakeTimer = null;
      return;
    }
    this.brakeTimer = setTimeout(() => void this.flushBrake(), BRAKE_WRITE_MS);
    this.brakeHoldUntil = performance.now() + BRAKE_ADOPT_AFTER_MS;
    try {
      await this.rig?.setBrake(v);
    } catch {
      /* the port went; onClose says so */
    }
  }

  async tare(): Promise<void> {
    if (this.connected) await this.rig!.tare();
  }

  async resetEncoder(): Promise<void> {
    if (this.connected) await this.rig!.resetEncoder();
  }

  async scanI2c(): Promise<number[] | null> {
    if (!this.connected) return null;
    this.set({ i2c: null });
    const found = await this.rig!.scanI2c();
    this.set({ i2c: found ?? [] });
    return found;
  }

  // ---- calibration ------------------------------------------------------------------

  async applyCalibration(countsPerRev: number, countsPerUnit: number): Promise<string | null> {
    if (!this.connected) return "The rig isn't connected.";
    if (!(countsPerRev > 0) || !Number.isFinite(countsPerUnit) || countsPerUnit === 0)
      return "Calibration needs a positive counts/rev and a non-zero counts/unit.";
    await this.rig!.setCalibration(countsPerRev, countsPerUnit);
    save("calibration", { countsPerRev, countsPerUnit });
    return null;
  }

  /** The calibration this browser last applied, if any. */
  savedCalibration(): { countsPerRev: number; countsPerUnit: number } | null {
    return load("calibration", null);
  }

  /**
   * On connecting, make the rig and this page agree on the calibration.
   * motorrig-1.3 keeps it in EEPROM, so the rig is the authority and the page
   * follows it -- across computers, too. A rig on the firmware's defaults has
   * either never been calibrated or is older firmware that lost it on the
   * restart connecting causes; then this page's copy, if it has one, goes
   * back on.
   */
  private async syncCalibrationOnConnect() {
    const s = this.rig?.status;
    if (!s || s.countsPerRev === null || s.countsPerUnit === null) return;
    const saved = this.savedCalibration();
    if (!onDefaultCalibration(s)) {
      save("calibration", { countsPerRev: s.countsPerRev, countsPerUnit: s.countsPerUnit });
      return;
    }
    const differs =
      saved &&
      (Math.abs(saved.countsPerRev - s.countsPerRev) > 1e-3 || Math.abs(saved.countsPerUnit / s.countsPerUnit - 1) > 1e-6);
    if (saved && differs) {
      await this.applyCalibration(saved.countsPerRev, saved.countsPerUnit);
      this.set({
        calibrationNote:
          `The rig had lost its calibration (older firmware forgets it when it restarts), so this page put yours back: ` +
          `${+saved.countsPerRev.toPrecision(7)} counts/rev, ${+saved.countsPerUnit.toPrecision(7)} counts/unit.`,
      });
    }
  }

  /** Listen to the load cell for a while and collect its tared readings. */
  collectLoadRaw(ms: number): Promise<number[]> {
    return new Promise((resolve) => {
      const readings: number[] = [];
      const rig = this.rig;
      if (!rig) return resolve(readings);
      const off = rig.on("status", (s) => {
        if (s.loadValid && !s.taring) readings.push(s.loadRaw);
      });
      setTimeout(() => {
        off();
        resolve(readings);
      }, ms);
    });
  }

  /** A rolling median of the calibrated load, for checking a calibration live. */
  medianLoad(ms: number): Promise<number | null> {
    return new Promise((resolve) => {
      const values: number[] = [];
      const rig = this.rig;
      if (!rig) return resolve(null);
      const off = rig.on("status", (s) => s.loadValid && values.push(s.load));
      setTimeout(() => {
        off();
        resolve(values.length ? median(values) : null);
      }, ms);
    });
  }

  /**
   * Tare, and wait until the rig has finished: it sends nothing when it
   * does. Resolves false if it never finishes -- the load cell is not
   * producing readings. A fast HX711 can finish all 16 readings between two
   * polls, so after a moment's grace a tare never seen running counts as done.
   */
  async tareAndWait(timeoutMs = TARE_TIMEOUT_MS): Promise<boolean> {
    const rig = this.rig;
    if (!rig) return false;
    const done = new Promise<boolean>((resolve) => {
      let started = false;
      const since = Date.now();
      const finish = (ok: boolean) => {
        off();
        clearTimeout(timer);
        resolve(ok);
      };
      const off = rig.on("status", (s) => {
        if (s.taring) started = true;
        else if (started || Date.now() - since > 1200) finish(true);
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
    await rig.tare();
    return done;
  }

  /** Wait out a tare already in progress. */
  waitForTare(timeoutMs = TARE_TIMEOUT_MS): Promise<boolean> {
    const rig = this.rig;
    if (!rig || !rig.status?.taring) return Promise.resolve(true);
    return new Promise((resolve) => {
      const off = rig.on("status", (s) => {
        if (!s.taring) {
          off();
          clearTimeout(timer);
          resolve(true);
        }
      });
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
    });
  }

  // ---- sweep settings ----------------------------------------------------------------

  setParams(patch: Partial<SweepParams>) {
    const params = mergeParams({ ...this.state.params, ...patch });
    save("params", params);
    this.set({ params });
  }

  resetParams() {
    save("params", DEFAULT_PARAMS);
    this.set({ params: { ...DEFAULT_PARAMS } });
  }

  setAutoDownload(on: boolean) {
    save("autoDownload", on);
    this.set({ autoDownload: on });
  }

  // ---- sweeps ---------------------------------------------------------------------

  get sweeping(): boolean {
    return !!this.runner;
  }

  async runSweep(motorId: string): Promise<SweepResult | null> {
    if (!this.connected || this.runner) return null;
    const log: string[] = [];
    const runner = new SweepRunner(
      this.rig!,
      this.state.params,
      {
        onLog: (line) => {
          log.push(line);
          this.setRun({ log: [...log] });
        },
        onState: (state) => this.setRun({ state }),
        onSample: (s) => {
          if (s.phase === "measure") this.setRun({ samples: [...this.state.run.samples, s] });
        },
        onStep: (p) => this.setRun({ steps: [...this.state.run.steps, p] }),
      },
      motorId.trim(),
    );
    this.runner = runner;
    this.set({ run: { ...EMPTY_RUN, running: true }, banner: null });
    if (motorId.trim()) log.push(`Motor ${motorId.trim()}`);

    const result = await runner.run();
    this.runner = null;
    this.setRun({ running: false, result, steps: result.steps });
    if (result.steps.length) {
      this.addResult(result);
      if (this.state.autoDownload) {
        this.downloadCurve();
        this.downloadRaw();
      }
    }
    return result;
  }

  cancelSweep() {
    this.runner?.cancel();
  }

  private fileName(result: SweepResult, kind: string): string {
    const id = safeName(result.motor_id);
    return `${id ? `${id}_` : ""}motor_${kind}_${stamp(new Date(result.started))}.csv`;
  }

  downloadCurve() {
    const r = this.state.run.result;
    if (r) download(this.fileName(r, "curve"), curveCsv(r));
  }

  downloadRaw() {
    const r = this.state.run.result;
    if (r) download(this.fileName(r, "raw"), rawCsv(r));
  }

  // ---- results ----------------------------------------------------------------------

  private addResult(result: SweepResult) {
    const row: ResultRow = {
      id: `${result.started}-${Math.random().toString(36).slice(2, 7)}`,
      motor: result.motor_id,
      started: result.started,
      status: result.error ? "Aborted" : result.cancelled ? "Cancelled" : result.stalled ? "Stalled" : "Complete",
      calibration: result.calibration,
      ...headline(result),
    };
    const results = [...this.state.results, row];
    save("results", results);
    this.set({ results });
  }

  setRef(id: string | null) {
    save("refId", id);
    this.set({ refId: id });
  }

  removeResult(id: string) {
    const results = this.state.results.filter((r) => r.id !== id);
    const refId = this.state.refId === id ? null : this.state.refId;
    save("results", results);
    save("refId", refId);
    this.set({ results, refId });
  }

  clearResults() {
    save("results", []);
    save("refId", null);
    this.set({ results: [], refId: null });
  }

  downloadSummary() {
    const { results, refId } = this.state;
    const ref = results.find((r) => r.id === refId) ?? null;
    const num = (v: number | null | undefined, d: number) => (v != null && Number.isFinite(v) ? v.toFixed(d) : "");
    const rows: (string | number)[][] = [[
      "motor", "started", "status", "reference", "supply_v", "counts_per_rev", "load_counts_per_unit", "load_unit",
      "no_load_rpm", "stall_torque_nm", "peak_power_w", "no_load_current_a", "peak_efficiency", "r2",
      "power_ratio", "torque_ratio", "speed_ratio", "friction_ratio", "score", "grade",
    ]];
    for (const r of results) {
      const found = r.id === refId ? null : grade(r, ref);
      const g = found && !("mismatch" in found) ? found : null;
      const c = r.calibration;
      rows.push([
        r.motor, r.started, r.status, r.id === refId ? "yes" : "", num(r.supply_v, 3), num(c?.countsPerRev, 3),
        num(c?.countsPerUnit, 1), c?.unit ?? "", num(r.no_load_rpm, 2), num(r.stall_torque_nm, 5),
        num(r.peak_power_w, 4), num(r.no_load_current_a, 4), num(r.peak_efficiency, 4), num(r.r2, 5),
        g ? num(g.power, 3) : "", g ? num(g.torque, 3) : "", g ? num(g.speed, 3) : "",
        g && g.friction !== null ? num(g.friction, 3) : "", g ? num(g.score, 1) : "", g ? g.grade : "",
      ]);
    }
    download(`motor_summary_${stamp(new Date())}.csv`, csv(rows));
  }

  // ---- leaving -----------------------------------------------------------------------

  /** Before the page closes: stop the rig, and say whether anything was running. */
  beforeUnload(): boolean {
    if (!this.connected) return false;
    const running = !!this.runner || !!this.rig!.status?.motorOn;
    this.rig!.estop().catch(() => {});
    return running;
  }
}

