import { describe, expect, test } from "vitest";
import * as P from "../src/lib/protocol";
import { MOTOR } from "../src/lib/simulator";
import { curveCsv, headline, mergeParams, rawCsv, SweepRunner } from "../src/lib/sweep";
import { close, connectSim, sleep } from "./helpers";

const FAST = { brake_step: 20, warmup_s: 0.8, settle_s: 0.6, dwell_s: 0.6, sample_hz: 50, load_unit: "kg·cm" } as const;

describe("whole sweeps against the simulator", () => {
  test("a sweep recovers the motor's curve", async () => {
    const { rig } = await connectSim();
    try {
      await rig.tare();
      await sleep(2000);
      const lines: string[] = [];
      const result = await new SweepRunner(rig, mergeParams(FAST), { onLog: (l) => lines.push(l) }, "M-001").run();
      expect(result.error).toBeNull();
      expect(result.cancelled).toBe(false);
      expect(result.steps).toHaveLength(6);
      expect(result.motor_id).toBe("M-001");
      const d = result.derived;
      // The model's 6 V motor, a little slower than rated as the leads drop
      // some of the supply under load.
      close(d.no_load_rpm, MOTOR.noLoadRpm, MOTOR.noLoadRpm * 0.1, "no-load rpm");
      close(d.stall_torque_nm, MOTOR.stallTorque, MOTOR.stallTorque * 0.15, "stall torque");
      close(result.supply_v, MOTOR.nominalV, 0.05, "supply read before the motor started");
      expect(result.calibration!.countsPerUnit).toBe(P.DEFAULT_CALIBRATION.countsPerUnit);
      expect(d.speed_fit!.r2).toBeGreaterThan(0.98);
      expect(lines.some((l) => l.startsWith("Sweep complete"))).toBe(true);

      const curve = curveCsv(result).trim().split("\n");
      expect(curve).toHaveLength(7);
      expect(curve[0].startsWith("step,brake_duty_pct,torque_nm,torque_sd,rpm")).toBe(true);
      expect(rawCsv(result).trim().split("\n")).toHaveLength(result.samples.length + 1);

      await sleep(50);
      const after = (await rig.requestStatus())!;
      expect(after.motorOn, "motor off after the sweep").toBe(false);
      expect(after.brake, "brake released after the sweep").toBe(0);
      const h = headline(result);
      expect(h.complete).toBe(true);
      expect(h.no_load_current_a!).toBeGreaterThan(0.1);
    } finally {
      await rig.close();
    }
  });

  test("cancelling stops it and leaves the rig safe", async () => {
    const { rig } = await connectSim();
    try {
      const runner = new SweepRunner(rig, mergeParams(FAST));
      setTimeout(() => runner.cancel(), 1200);
      const t0 = Date.now();
      const result = await runner.run();
      expect(Date.now() - t0, "cancel takes effect promptly").toBeLessThan(2500);
      expect(result.cancelled).toBe(true);
      await sleep(50);
      const after = (await rig.requestStatus())!;
      expect(after.motorOn).toBe(false);
      expect(after.brake).toBe(0);
    } finally {
      await rig.close();
    }
  });

  test("losing the rig mid-sweep aborts with a reason", async () => {
    const { rig, sim } = await connectSim();
    const runner = new SweepRunner(rig, mergeParams(FAST));
    setTimeout(() => sim.onClose("unplugged"), 1000);
    const result = await runner.run();
    expect(result.error).toMatch(/disconnected/);
  });

  test("a low ERC2 battery aborts it", async () => {
    const { rig } = await connectSim();
    try {
      const result = await new SweepRunner(rig, mergeParams({ ...FAST, min_battery_v: 12.5 })).run();
      expect(result.error).toMatch(/ERC2's battery dropped/);
    } finally {
      await rig.close();
    }
  });

  test("a bench supply set to the wrong voltage stops it before the motor starts", async () => {
    const { rig } = await connectSim({ supplyV: 12 });
    let started = false;
    rig.on("status", (s) => (started = started || s.motorOn));
    try {
      const result = await new SweepRunner(rig, mergeParams(FAST)).run();
      expect(result.error).toMatch(/reads 12\.0\d V, but this sweep is set for 6\.0 V/);
      expect(started, "the motor never ran").toBe(false);
      expect(result.steps).toHaveLength(0);
    } finally {
      await rig.close();
    }
  });

  test("single bad supply readings don't stop it", async () => {
    // The real rig's INA219 now and then returns one reading 20-25% low.
    const { rig } = await connectSim({ glitchRate: 0.08 });
    try {
      const result = await new SweepRunner(rig, mergeParams(FAST)).run();
      expect(result.error).toBeNull();
      const low = result.samples.filter((s) => s.phase !== "warmup" && s.voltage < MOTOR.nominalV * 0.85);
      expect(low.length, "the glitches did happen").toBeGreaterThan(0);
    } finally {
      await rig.close();
    }
  });

  test("a bench supply hitting its current limit aborts it", async () => {
    const { rig } = await connectSim({ supplyLimitA: 1.0 });
    try {
      const result = await new SweepRunner(rig, mergeParams(FAST)).run();
      expect(result.error).toMatch(/motor supply sagged/);
    } finally {
      await rig.close();
    }
  });

  test("Motor voltage 0 turns the supply checks off", async () => {
    const { rig } = await connectSim({ supplyV: 12 });
    try {
      const runner = new SweepRunner(rig, mergeParams({ ...FAST, motor_v: 0, brake_step: 50, warmup_s: 0.3 }));
      setTimeout(() => runner.cancel(), 1500);
      expect((await runner.run()).error).toBeNull();
    } finally {
      await rig.close();
    }
  });
});
