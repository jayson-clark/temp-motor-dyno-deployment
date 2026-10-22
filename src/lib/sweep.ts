// Motor characterization sweep: load the test motor with the brake in steps,
// capture a burst of telemetry at each, and reduce the bursts to a TNI curve
// -- torque (T) against speed (N) and current (I) -- plus the power and
// efficiency derived from the same samples.
//
// Ported from ERC2 Link's rig_test.py, which this app replaces: the same
// filtering and fits, and the same CSV columns, so curves measured here
// compare with those measured there.
//
// Why bursts instead of single reads: one frame is noisy. The HX711 publishes
// at ~10 Hz with several counts of jitter, RPM is a 100 ms difference of
// encoder counts, and the INA219 current swings with commutation. So each
// brake step is held for a settle window (discarded: the motor is still
// slowing to its new operating point), then a dwell window sampled as fast as
// the link allows. The dwell samples go through MAD rejection -- points more
// than k median-absolute-deviations from the median are dropped, which kills
// HX711 spikes without the mean-dragging a plain 3σ test suffers on a small
// skewed sample -- and then a trimmed mean. Every raw sample is kept, so the
// scatter behind each point can be shown and exported.

import type { RigStatus } from "./protocol";
import { linearFit, madKeep, median, summarize, trimmedMean, type Fit, type Summary } from "./stats";

const G = 9.80665;

// From one calibrated load unit to newtons at the arm. N·m and kg·cm are
// torques already and bypass the arm.
const FORCE_UNITS: Record<string, number> = { g: G / 1000, kg: G, N: 1 };
const TORQUE_UNITS: Record<string, number> = { "N·m": 1, "kg·cm": G * 0.01 };
export const LOAD_UNITS = ["kg·cm", "N·m", "g", "kg", "N"] as const;
export type LoadUnit = (typeof LOAD_UNITS)[number];

// A frame must arrive within this long before it counts as missed.
const FRAME_TIMEOUT_MS = 1500;
// Consecutive missed frames tolerated before the run is abandoned, counted
// across the whole sweep: a short window can only time out once or twice on
// its own, so a per-window limit would let a dead link grind through every
// step and "finish" with no data.
const MAX_MISSED_FRAMES = 5;
// The test motor runs from a bench supply set to its voltage. Before the
// motor starts, the supply (read with the motor off, so with no drop in the
// leads) must be within this of the setting: a 6 V motor on a supply left at
// 12 V is the mistake this exists for.
export const SUPPLY_TOLERANCE = 0.1;
// Under load the motor's voltage sags through the leads and the INA219's
// shunt, a few percent at stall. Much more than this and the supply is
// current-limiting, and the curve would be measured at the wrong voltage.
export const SUPPLY_SAG_LIMIT = 0.15;
// Both voltage checks judge the median of the last quarter second, never one
// reading. The INA219 now and then returns a single reading far off the rest
// -- the brake's 500 Hz switching gets into it -- and a real fault (a supply
// current-limiting, a battery running down) stays low, so the median still
// catches it within this window.
const VOLTAGE_WINDOW_S = 0.25;
const VOLTAGE_WINDOW_MIN = 5;

export interface SweepParams {
  /** The test motor's supply voltage, as set on the bench supply (0 skips the supply checks). */
  motor_v: number;
  brake_start: number;
  brake_end: number;
  brake_step: number;
  /** Also sweep back down, to expose hysteresis. */
  bidirectional: boolean;
  /** Unloaded spin-up before the first step. */
  warmup_s: number;
  /** Discarded after each brake change. */
  settle_s: number;
  /** Sampled window. */
  dwell_s: number;
  /** Request rate inside the dwell. */
  sample_hz: number;
  mad_k: number;
  trim: number;
  load_unit: LoadUnit;
  /** Load-cell lever arm, for force units only. */
  arm_mm: number;
  invert_load: boolean;
  /** Subtract the unloaded warm-up torque. */
  auto_zero: boolean;
  stall_rpm: number;
  stop_on_stall: boolean;
  /** Abort if the ERC2's own battery falls below this (0 disables). */
  min_battery_v: number;
}

export const DEFAULT_PARAMS: SweepParams = {
  motor_v: 6.0,
  brake_start: 0,
  brake_end: 100,
  brake_step: 5,
  bidirectional: false,
  warmup_s: 2.0,
  settle_s: 1.2,
  dwell_s: 1.5,
  sample_hz: 50.0,
  mad_k: 3.5,
  trim: 0.2,
  // The firmware's default calibration (390000 counts per unit) only makes
  // sense per kg·cm: per gram, the 24-bit HX711 would top out near 21 g.
  load_unit: "kg·cm",
  arm_mm: 38.0, // the rig's lever arm
  invert_load: false,
  auto_zero: true,
  stall_rpm: 5.0,
  stop_on_stall: true,
  min_battery_v: 5.5,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** DEFAULT_PARAMS updated with the recognised keys of `overrides`, clamped. */
export function mergeParams(overrides?: Partial<Record<keyof SweepParams, unknown>> | null): SweepParams {
  const p: Record<string, unknown> = { ...DEFAULT_PARAMS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in p)) continue;
    const def = p[key];
    if (typeof def === "boolean") p[key] = !!value;
    else if (typeof def === "number") {
      const n = Number(value);
      if (Number.isFinite(n)) p[key] = key.startsWith("brake_") ? Math.round(n) : n;
    } else p[key] = String(value);
  }
  const q = p as unknown as SweepParams;
  q.brake_start = clamp(q.brake_start, 0, 100);
  q.brake_end = clamp(q.brake_end, 0, 100);
  q.brake_step = clamp(Math.abs(q.brake_step), 1, 100);
  q.warmup_s = clamp(q.warmup_s, 0, 30);
  q.settle_s = clamp(q.settle_s, 0, 30);
  q.dwell_s = clamp(q.dwell_s, 0.2, 60);
  q.sample_hz = clamp(q.sample_hz, 1, 100);
  q.mad_k = clamp(q.mad_k, 0.5, 20);
  q.trim = clamp(q.trim, 0, 0.4);
  q.arm_mm = Math.max(0, q.arm_mm);
  q.stall_rpm = Math.max(0, q.stall_rpm);
  q.min_battery_v = Math.max(0, q.min_battery_v);
  q.motor_v = clamp(q.motor_v, 0, 48);
  if (!(LOAD_UNITS as readonly string[]).includes(q.load_unit)) q.load_unit = "kg·cm";
  return q;
}

/** The brake duties a sweep visits, in order. */
export function buildSchedule(p: Pick<SweepParams, "brake_start" | "brake_end" | "brake_step" | "bidirectional">): number[] {
  const { brake_start: start, brake_end: end, brake_step: step } = p;
  const dir = end >= start ? 1 : -1;
  const duties: number[] = [];
  for (let d = start; dir > 0 ? d <= end : d >= end; d += dir * step) duties.push(d);
  if (duties[duties.length - 1] !== end) duties.push(end);
  if (p.bidirectional) duties.push(...duties.slice(0, -1).reverse());
  return duties;
}

/** A calibrated load reading as torque in N·m, as the sweep converts it. */
export function torqueNm(load: number, p: Pick<SweepParams, "load_unit" | "arm_mm" | "invert_load">): number {
  if (p.invert_load) load = -load;
  if (p.load_unit in TORQUE_UNITS) return load * TORQUE_UNITS[p.load_unit];
  return load * FORCE_UNITS[p.load_unit] * (p.arm_mm / 1000);
}

// ---- results ----------------------------------------------------------------

export type Phase = "warmup" | "settle" | "measure";

export interface Sample {
  t: number;
  step: number;
  duty: number;
  phase: Phase;
  torque: number;
  rpm: number;
  current: number;
  voltage: number;
  elec_w: number;
  mech_w: number;
  gen_i: number;
  gen_v: number;
  load: number;
  load_raw: number;
  battery: number;
}

export interface Step {
  index: number;
  duty: number;
  t_start: number;
  t_end: number;
  torque: Summary;
  rpm: Summary;
  current: Summary;
  voltage: Summary;
  gen_i: Summary;
  gen_v: Summary;
  mech_w: number;
  elec_w: number;
  gen_w: number;
  efficiency: number;
  battery: number;
}

export interface Derived {
  speed_fit?: Fit | null;
  current_fit?: Fit | null;
  no_load_rpm?: number;
  stall_torque_nm?: number;
  no_load_current_a?: number;
  stall_current_a?: number;
  peak_power_fit?: { torque_nm: number; rpm: number; watts: number };
  peak_power_measured?: { duty: number; torque_nm: number; rpm: number; watts: number };
  peak_efficiency?: { duty: number; torque_nm: number; efficiency: number };
  max_current_a?: number;
}

export interface Calibration {
  countsPerRev: number | null;
  countsPerUnit: number | null;
  unit: LoadUnit;
}

export interface SweepResult {
  motor_id: string;
  params: SweepParams;
  schedule: number[];
  started: string;
  duration_s: number;
  steps: Step[];
  samples: Sample[];
  sample_count: number;
  rejected: number;
  zero_torque_nm: number;
  supply_v: number | null;
  calibration: Calibration | null;
  cancelled: boolean;
  stalled: boolean;
  error: string | null;
  derived: Derived;
}

export interface SweepState {
  phase: Phase;
  step: number;
  steps_total: number;
  duty: number;
  elapsed: number;
  samples: number;
}

/** Fit the TNI lines and pull the headline numbers off them. */
export function derive(steps: readonly Step[]): Derived {
  const d: Derived = {};
  if (steps.length < 2) return d;
  const speedFit = linearFit(steps.map((s) => [s.torque.value, s.rpm.value] as const));
  const currentFit = linearFit(steps.map((s) => [s.torque.value, s.current.value] as const));
  d.speed_fit = speedFit;
  d.current_fit = currentFit;
  if (speedFit && speedFit.slope < 0) {
    const noLoad = speedFit.intercept;
    const stallTorque = -noLoad / speedFit.slope;
    d.no_load_rpm = noLoad;
    d.stall_torque_nm = stallTorque;
    if (currentFit) {
      d.no_load_current_a = currentFit.intercept;
      d.stall_current_a = currentFit.slope * stallTorque + currentFit.intercept;
    }
    // A linear TNI curve peaks at exactly half the stall torque; reported
    // beside the best point actually measured.
    const peakTorque = stallTorque / 2;
    const peakRpm = speedFit.slope * peakTorque + speedFit.intercept;
    d.peak_power_fit = { torque_nm: peakTorque, rpm: peakRpm, watts: (peakTorque * peakRpm * 2 * Math.PI) / 60 };
  }
  const best = steps.reduce((a, s) => (s.mech_w > a.mech_w ? s : a));
  d.peak_power_measured = { duty: best.duty, torque_nm: best.torque.value, rpm: best.rpm.value, watts: best.mech_w };
  const eff = steps.reduce((a, s) => (s.efficiency > a.efficiency ? s : a));
  d.peak_efficiency = { duty: eff.duty, torque_nm: eff.torque.value, efficiency: eff.efficiency };
  d.max_current_a = Math.max(...steps.map((s) => s.current.value));
  return d;
}

// ---- runner -----------------------------------------------------------------

/** What a sweep needs from a rig; RigClient is one. */
export interface SweepRig {
  closed: boolean;
  requestStatus(timeoutMs?: number): Promise<RigStatus | null>;
  setBrake(duty: number): Promise<void>;
  setMotor(on: boolean): Promise<void>;
  pausePolling(paused: boolean): void;
}

export interface SweepHooks {
  onLog?: (line: string) => void;
  onState?: (state: SweepState) => void;
  onSample?: (sample: Sample) => void;
  onStep?: (step: Step) => void;
}

const now = () => performance.now() / 1000;

export class SweepRunner {
  readonly schedule: number[];
  readonly samples: Sample[] = [];
  readonly steps: Step[] = [];
  cancelled = false;
  private hooks: Required<SweepHooks>;
  private error: string | null = null;
  private stalled = false;
  private missed = 0;
  private zeroTorque = 0;
  private supplyV: number | null = null;
  private calibration: Calibration | null = null;
  private t0 = 0;
  private started = new Date();
  private wakers = new Set<() => void>();
  // Recent loaded-step readings, for the voltage checks.
  private recentSupply: number[] = [];
  private recentBattery: number[] = [];

  constructor(
    private readonly rig: SweepRig,
    readonly params: SweepParams,
    hooks: SweepHooks = {},
    readonly motorId = "",
  ) {
    this.hooks = { onLog() {}, onState() {}, onSample() {}, onStep() {}, ...hooks };
    this.schedule = buildSchedule(params);
  }

  cancel() {
    this.cancelled = true;
    for (const wake of this.wakers) wake();
  }

  /** Sleep, but wake straight away on cancel. Resolves true if cancelled. */
  private wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.cancelled) return resolve(true);
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve(this.cancelled);
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  private makeSample(frame: RigStatus, duty: number, step: number, phase: Phase): Sample {
    const torque = torqueNm(frame.load, this.params) - this.zeroTorque;
    const current = frame.test.currentMa / 1000;
    const voltage = frame.test.voltageV;
    const omega = (frame.rpm * 2 * Math.PI) / 60;
    return {
      t: Math.round((now() - this.t0) * 1e4) / 1e4,
      step,
      duty,
      phase,
      torque,
      rpm: frame.rpm,
      current,
      voltage,
      elec_w: voltage * current,
      mech_w: torque * omega,
      gen_i: frame.gen.currentMa / 1000,
      gen_v: frame.gen.voltageV,
      load: frame.load,
      load_raw: frame.loadRaw,
      battery: frame.batteryV,
    };
  }

  /**
   * Sample as close to sample_hz as the link allows for `seconds`. A run of
   * missed frames aborts the sweep: averaging over a dead link would give a
   * plausible-looking curve made of stale numbers.
   */
  private async collect(duty: number, step: number, phase: Phase, seconds: number): Promise<Sample[]> {
    const period = 1 / this.params.sample_hz;
    const collected: Sample[] = [];
    const deadline = now() + seconds;
    let nextAt = now();
    while (now() < deadline && !this.cancelled) {
      const frame = await this.rig.requestStatus(FRAME_TIMEOUT_MS);
      if (!frame) {
        if (this.cancelled) break;
        if (this.rig.closed) {
          this.error = "The rig disconnected";
          return collected;
        }
        if (++this.missed >= MAX_MISSED_FRAMES) {
          this.error = "Lost telemetry from the rig";
          return collected;
        }
        continue;
      }
      this.missed = 0;
      const sample = this.makeSample(frame, duty, step, phase);
      this.samples.push(sample);
      collected.push(sample);
      this.hooks.onSample(sample);

      const window = Math.max(VOLTAGE_WINDOW_MIN, Math.round(VOLTAGE_WINDOW_S * this.params.sample_hz));
      const settled = (recent: number[], v: number) => {
        recent.push(v);
        if (recent.length > window) recent.shift();
        return recent.length >= window ? median(recent) : null;
      };

      const limit = this.params.min_battery_v;
      const battery = sample.battery > 1 ? settled(this.recentBattery, sample.battery) : null;
      if (limit > 0 && battery !== null && battery < limit) {
        this.error = `The ERC2's battery dropped to ${battery.toFixed(2)} V (limit ${limit.toFixed(2)} V)`;
        return collected;
      }
      // The motor is still spinning up in the warm-up, drawing several times
      // its running current, so only loaded steps are judged.
      const motorV = this.params.motor_v;
      const supply = phase !== "warmup" && frame.inaTestOk ? settled(this.recentSupply, sample.voltage) : null;
      if (motorV > 0 && supply !== null && supply < motorV * (1 - SUPPLY_SAG_LIMIT)) {
        this.error =
          `The motor supply sagged to ${supply.toFixed(2)} V at ${duty}% brake (set for ${motorV.toFixed(1)} V). ` +
          "Raise the bench supply's current limit, or check the motor leads.";
        return collected;
      }

      nextAt += period;
      const wait = nextAt - now();
      if (wait > 0) {
        if (await this.wait(wait * 1000)) break;
      } else {
        nextAt = now(); // behind: stop accumulating debt
      }
    }
    return collected;
  }

  private emitState(phase: Phase, step: number, duty: number) {
    this.hooks.onState({
      phase,
      step,
      steps_total: this.schedule.length,
      duty,
      elapsed: Math.round((now() - this.t0) * 100) / 100,
      samples: this.samples.length,
    });
  }

  /** Run the whole sweep; resolves with the result, whatever happened. */
  async run(): Promise<SweepResult> {
    this.t0 = now();
    this.started = new Date();
    this.rig.pausePolling(true);
    try {
      await this.sweep();
    } catch (err) {
      const e = err as Error;
      this.error = `${e?.name ?? "Error"}: ${e?.message ?? err}`;
      this.hooks.onLog(`Sweep error: ${this.error}`);
    } finally {
      await this.shutdownRig();
      this.rig.pausePolling(false);
    }
    return this.compile();
  }

  private async sweep() {
    const p = this.params;
    const log = this.hooks.onLog;
    log(
      `Sweep: ${this.schedule.length} brake steps (${p.brake_start}%→${p.brake_end}% by ${p.brake_step}%), ` +
        `${p.dwell_s.toFixed(1)} s dwell @ ${p.sample_hz.toFixed(0)} Hz`,
    );

    // A known start: brake released and, before the motor runs, a look at
    // what it is about to run on.
    await this.rig.setBrake(0);
    await this.rig.setMotor(false);
    const before = await this.rig.requestStatus(FRAME_TIMEOUT_MS);
    if (!before) {
      this.error = "No telemetry from the rig";
      return;
    }
    this.calibration = { countsPerRev: before.countsPerRev, countsPerUnit: before.countsPerUnit, unit: p.load_unit };
    if (before.countsPerRev !== null && before.countsPerUnit !== null)
      log(`Calibration: ${+before.countsPerRev.toPrecision(6)} counts/rev, ${+before.countsPerUnit.toPrecision(6)} counts per ${p.load_unit}`);
    if (before.inaTestOk) this.supplyV = before.test.voltageV;
    if (p.motor_v > 0) {
      if (!before.inaTestOk) {
        this.error = "The test-motor INA219 isn't answering, so the motor supply can't be checked. Scan the I2C bus under Calibrate.";
        return;
      }
      const v = before.test.voltageV;
      if (Math.abs(v - p.motor_v) > p.motor_v * SUPPLY_TOLERANCE) {
        this.error =
          v < 0.5
            ? `The motor supply reads ${v.toFixed(2)} V: is the bench supply on? This sweep is set for ${p.motor_v.toFixed(1)} V.`
            : `The motor supply reads ${v.toFixed(2)} V, but this sweep is set for ${p.motor_v.toFixed(1)} V. ` +
              "Set the bench supply, or change Motor voltage in the settings. The motor was not started.";
        return;
      }
      log(`Motor supply: ${v.toFixed(2)} V (set for ${p.motor_v.toFixed(1)} V)`);
    }
    await this.rig.setMotor(true);

    if (p.warmup_s > 0) {
      this.emitState("warmup", 0, 0);
      log(`Warm-up: ${p.warmup_s.toFixed(1)} s unloaded…`);
      const warm = await this.collect(0, -1, "warmup", p.warmup_s);
      if (p.auto_zero && warm.length) {
        // The unloaded reading is the zero of the torque axis: it takes out
        // tare drift, and wherever the generator cradle settles once it runs.
        const zero = trimmedMean(madKeep(warm.map((s) => s.torque), p.mad_k), p.trim);
        this.zeroTorque = zero;
        for (const s of warm) s.torque -= zero;
        log(`Auto-zero: subtracting ${zero.toFixed(4)} N·m from torque`);
      }
      if (this.error || this.cancelled) return;
    }

    for (let index = 0; index < this.schedule.length; index++) {
      const duty = this.schedule[index];
      if (this.cancelled || this.error) return;

      await this.rig.setBrake(duty);
      this.emitState("settle", index, duty);
      log(`Step ${index + 1}/${this.schedule.length}: brake ${duty}% — settling…`);
      if (p.settle_s > 0) await this.collect(duty, index, "settle", p.settle_s);
      if (this.cancelled || this.error) return;

      this.emitState("measure", index, duty);
      const dwell = await this.collect(duty, index, "measure", p.dwell_s);
      if (this.error) return;
      if (!dwell.length) continue;

      const point = this.reduceStep(index, duty, dwell);
      this.steps.push(point);
      this.hooks.onStep(point);
      log(
        `  τ=${point.torque.value.toFixed(4)} N·m  N=${point.rpm.value.toFixed(0)} rpm  ` +
          `I=${point.current.value.toFixed(3)} A  (${point.rpm.n_used}/${point.rpm.n} samples kept)`,
      );

      if (point.rpm.value <= p.stall_rpm) {
        this.stalled = true;
        log(`  Stalled at ${duty}% brake.`);
        if (p.stop_on_stall) {
          log("Stopping the sweep: the motor is stalled.");
          return;
        }
      }
    }
  }

  private reduceStep(index: number, duty: number, dwell: Sample[]): Step {
    const kw = { mad_k: this.params.mad_k, trim: this.params.trim };
    const ch = (name: keyof Sample) => summarize(dwell.map((s) => s[name] as number), kw);
    const torque = ch("torque");
    const rpm = ch("rpm");
    const current = ch("current");
    const voltage = ch("voltage");
    const gen_i = ch("gen_i");
    const gen_v = ch("gen_v");
    // Power from the filtered channels, not the mean of per-sample products:
    // the load cell and encoder update at different rates, so their
    // instantaneous product is noisier and biased high.
    const omega = (rpm.value * 2 * Math.PI) / 60;
    const mech_w = torque.value * omega;
    const elec_w = voltage.value * current.value;
    return {
      index,
      duty,
      t_start: dwell[0].t,
      t_end: dwell[dwell.length - 1].t,
      torque,
      rpm,
      current,
      voltage,
      gen_i,
      gen_v,
      mech_w,
      elec_w,
      gen_w: gen_v.value * gen_i.value,
      efficiency: elec_w > 0.05 ? mech_w / elec_w : 0,
      battery: ch("battery").value,
    };
  }

  /** Always leave the rig safe: brake released, test motor off. */
  private async shutdownRig() {
    try {
      await this.rig.setBrake(0);
      await this.rig.setMotor(false);
    } catch {
      /* the rig is gone */
    }
  }

  private compile(): SweepResult {
    // Each channel is filtered on its own -- a load-cell spike says nothing
    // about the encoder window it shares -- so rejections are summed over the
    // three channels the curve is built from.
    const rejected = this.steps.reduce(
      (a, s) => a + (["torque", "rpm", "current"] as const).reduce((b, c) => b + s[c].n - s[c].n_used, 0),
      0,
    );
    const result: SweepResult = {
      motor_id: this.motorId,
      params: { ...this.params },
      schedule: [...this.schedule],
      started: this.started.toISOString(),
      duration_s: Math.round((now() - this.t0) * 100) / 100,
      steps: this.steps,
      samples: this.samples,
      sample_count: this.samples.length,
      rejected,
      zero_torque_nm: this.zeroTorque,
      supply_v: this.supplyV,
      calibration: this.calibration,
      cancelled: this.cancelled,
      stalled: this.stalled,
      error: this.error,
      derived: derive(this.steps),
    };
    const log = this.hooks.onLog;
    if (this.cancelled) log(`Sweep cancelled after ${this.steps.length} steps.`);
    else if (this.error) log(`Sweep aborted: ${this.error}`);
    else log(`Sweep complete: ${this.steps.length} points from ${result.sample_count} samples (${rejected} rejected by the filter).`);
    return result;
  }
}

// ---- export -----------------------------------------------------------------

export function csv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

/** One row per brake step; the same columns ERC2 Link wrote. */
export function curveCsv(result: SweepResult): string {
  return csv([
    ["step", "brake_duty_pct", "torque_nm", "torque_sd", "rpm", "rpm_sd", "current_a", "current_sd",
      "voltage_v", "mech_w", "elec_w", "gen_w", "efficiency", "samples", "samples_used"],
    ...result.steps.map((s) => [
      s.index, s.duty, s.torque.value.toFixed(6), s.torque.sd.toFixed(6), s.rpm.value.toFixed(3),
      s.rpm.sd.toFixed(3), s.current.value.toFixed(4), s.current.sd.toFixed(4), s.voltage.value.toFixed(3),
      s.mech_w.toFixed(4), s.elec_w.toFixed(4), s.gen_w.toFixed(4), s.efficiency.toFixed(4), s.rpm.n,
      s.rpm.n_used,
    ]),
  ]);
}

/** Every raw sample of the run. */
export function rawCsv(result: SweepResult): string {
  return csv([
    ["t_s", "step", "brake_duty_pct", "phase", "torque_nm", "rpm", "current_a", "voltage_v", "gen_i_a",
      "gen_v", "load", "load_raw", "battery_v"],
    ...result.samples.map((s) => [
      s.t, s.step, s.duty, s.phase, s.torque.toFixed(6), s.rpm.toFixed(3), s.current.toFixed(4),
      s.voltage.toFixed(3), s.gen_i.toFixed(4), s.gen_v.toFixed(3), s.load.toFixed(6), s.load_raw,
      s.battery.toFixed(3),
    ]),
  ]);
}

// ---- grading ----------------------------------------------------------------

export interface Headline {
  no_load_rpm: number | null;
  stall_torque_nm: number | null;
  peak_power_w: number | null;
  no_load_current_a: number | null;
  peak_efficiency: number | null;
  r2: number | null;
  supply_v: number | null;
  complete: boolean;
}

/** The numbers a motor is judged by, from one sweep. */
export function headline(result: Pick<SweepResult, "derived" | "steps" | "supply_v" | "cancelled" | "error" | "stalled">): Headline {
  const d = result.derived ?? {};
  const zero = result.steps.find((s) => s.duty === 0);
  return {
    no_load_rpm: d.no_load_rpm ?? null,
    stall_torque_nm: d.stall_torque_nm ?? null,
    peak_power_w: d.peak_power_measured?.watts ?? null,
    // The guide's "no-load current" is the 0 % row as measured.
    no_load_current_a: zero ? zero.current.value : (d.no_load_current_a ?? null),
    peak_efficiency: d.peak_efficiency?.efficiency ?? null,
    r2: d.speed_fit?.r2 ?? null,
    supply_v: result.supply_v ?? null,
    complete: !result.cancelled && !result.error && !result.stalled,
  };
}

export type Grade =
  | { mismatch: string }
  | { power: number; torque: number; speed: number; friction: number | null; score: number; grade: "A" | "B" | "C" | "Reject" };

/**
 * The grading scheme the Operator Guide suggests (section 8.3), against a
 * reference motor: ratios to the reference, a score with peak power counting
 * double, and a grade that also needs low friction and a clean fit. A
 * starting point the guide expects to be tuned after 20-30 motors.
 */
export function grade(h: Headline, ref: Headline | null): Grade | null {
  // Speed and torque both scale with voltage, so motors run at different
  // voltages are not comparable, and no grade is better than a wrong one.
  if (ref && h.supply_v != null && ref.supply_v != null && h.supply_v > 0 && ref.supply_v > 0 &&
      Math.abs(h.supply_v / ref.supply_v - 1) > 0.05)
    return { mismatch: `Tested at ${h.supply_v.toFixed(2)} V, the reference at ${ref.supply_v.toFixed(2)} V` };
  if (!ref) return null;
  const nums = [h.no_load_rpm, h.stall_torque_nm, h.peak_power_w, ref.no_load_rpm, ref.stall_torque_nm, ref.peak_power_w];
  if (!nums.every((v) => v != null && Number.isFinite(v))) return null;
  const power = h.peak_power_w! / ref.peak_power_w!;
  const torque = h.stall_torque_nm! / ref.stall_torque_nm!;
  const speed = h.no_load_rpm! / ref.no_load_rpm!;
  const friction =
    h.no_load_current_a != null && Number.isFinite(h.no_load_current_a) && ref.no_load_current_a! > 0
      ? h.no_load_current_a / ref.no_load_current_a!
      : null;
  const score = ((2 * power + torque + speed) / 4) * 100;
  const r2 = h.r2 ?? 0;
  let letter: "A" | "B" | "C" | "Reject" = "Reject";
  if (!h.complete || (friction !== null && friction > 2.5) || r2 < 0.98) letter = "Reject";
  else if (score >= 90 && (friction === null || friction <= 1.5) && r2 >= 0.99) letter = "A";
  else if (score >= 75 && (friction === null || friction <= 2.0)) letter = "B";
  else if (score >= 60) letter = "C";
  return { power, torque, speed, friction, score, grade: letter };
}
