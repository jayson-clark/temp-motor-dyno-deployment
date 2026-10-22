import { describe, expect, test } from "vitest";
import { madKeep, summarize, linearFit } from "../src/lib/stats";
import { buildSchedule, derive, grade, mergeParams, torqueNm, type Headline, type Step } from "../src/lib/sweep";
import { close } from "./helpers";

describe("sweep maths", () => {
  test("the brake schedule covers start to end, inclusive", () => {
    const s = (o: object) => buildSchedule(mergeParams(o));
    expect(s({})).toHaveLength(21);
    expect(s({ brake_start: 0, brake_end: 100, brake_step: 30 })).toEqual([0, 30, 60, 90, 100]);
    expect(s({ brake_start: 50, brake_end: 0, brake_step: 25 })).toEqual([50, 25, 0]);
    expect(s({ brake_start: 0, brake_end: 20, brake_step: 10, bidirectional: true })).toEqual([0, 10, 20, 10, 0]);
  });

  test("parameters are clamped and unknown keys ignored", () => {
    const p = mergeParams({ brake_step: -7, dwell_s: 0, trim: 0.9, load_unit: "lb", bogus: 1, sample_hz: "20" } as never);
    expect(p.brake_step).toBe(7);
    expect(p.dwell_s).toBe(0.2);
    expect(p.trim).toBe(0.4);
    expect(p.load_unit).toBe("kg·cm");
    expect(p.sample_hz).toBe(20);
    expect("bogus" in p).toBe(false);
  });

  test("load converts to torque in every unit", () => {
    const p = mergeParams({});
    close(torqueNm(1, { ...p, load_unit: "kg·cm" }), 0.0980665, 1e-12, "kg·cm");
    close(torqueNm(1, { ...p, load_unit: "N·m" }), 1, 1e-12, "N·m");
    close(torqueNm(100, { ...p, load_unit: "g", arm_mm: 38 }), 0.1 * 9.80665 * 0.038, 1e-12, "g at 38 mm");
    close(torqueNm(1, { ...p, load_unit: "N·m", invert_load: true }), -1, 1e-12, "inverted");
  });

  test("MAD rejection drops a load-cell spike the mean would follow", () => {
    const values = [10, 10.2, 9.9, 10.1, 9.8, 10, 250, 10.1];
    expect(madKeep(values, 3.5)).not.toContain(250);
    const s = summarize(values, { mad_k: 3.5, trim: 0.2 });
    close(s.value, 10.02, 0.1, "filtered value");
    expect(s.n).toBe(8);
    expect(s.n_used).toBe(7);
    // A stalled shaft reading exactly zero keeps its zeros.
    expect(madKeep([0, 0, 0, 0, 0, 3], 3.5)).toEqual([0, 0, 0, 0, 0]);
  });

  test("the linear fit recovers a line, and derive() the motor's figures", () => {
    const fit = linearFit([[0, 160], [0.1, 120], [0.2, 80], [0.3, 40]])!;
    close(fit.slope, -400, 1e-9, "slope");
    close(fit.intercept, 160, 1e-9, "intercept");
    close(fit.r2, 1, 1e-12, "r2");
    const step = (t: number, rpm: number, a: number) => {
      const v = (value: number) => ({ value, n: 10, n_used: 10, sd: 0, median: value, sem: 0, min: value, max: value });
      const mech = (t * rpm * 2 * Math.PI) / 60;
      return { duty: 0, torque: v(t), rpm: v(rpm), current: v(a), mech_w: mech, efficiency: mech / (12 * a) } as unknown as Step;
    };
    const d = derive([step(0, 160, 0.15), step(0.1, 120, 0.76), step(0.2, 80, 1.38)]);
    close(d.no_load_rpm, 160, 1e-6, "no-load rpm");
    close(d.stall_torque_nm, 0.4, 1e-9, "stall torque");
    close(d.no_load_current_a, 0.15, 0.01, "no-load current");
    close(d.peak_power_fit!.torque_nm, 0.2, 1e-9, "peak power torque");
  });

  test("grading follows the Operator Guide's scheme", () => {
    const ref: Headline = { no_load_rpm: 160, stall_torque_nm: 0.4, peak_power_w: 1.6, no_load_current_a: 0.15, peak_efficiency: 0.3, r2: 0.999, supply_v: null, complete: true };
    const g = (o: Partial<Headline>) => grade({ ...ref, ...o }, ref) as { grade: string; score: number };
    expect(g({}).grade).toBe("A");
    expect(g({}).score).toBe(100);
    expect(g({ peak_power_w: 1.3, stall_torque_nm: 0.34 }).grade).toBe("B"); // score ~ 83
    expect(g({ no_load_current_a: 0.27 }).grade).toBe("B"); // friction 1.8: too high for A
    expect(g({ peak_power_w: 1.0, stall_torque_nm: 0.3, no_load_rpm: 140 }).grade).toBe("C");
    expect(g({ peak_power_w: 0.6, stall_torque_nm: 0.2 }).grade).toBe("Reject");
    expect(g({ no_load_current_a: 0.4 }).grade).toBe("Reject"); // friction > 2.5
    expect(g({ r2: 0.97 }).grade).toBe("Reject");
    expect(g({ complete: false }).grade).toBe("Reject");
    expect(grade(ref, null)).toBeNull();
  });

  test("motors run at different voltages are not graded against each other", () => {
    const ref: Headline = { no_load_rpm: 120, stall_torque_nm: 0.085, peak_power_w: 0.27, no_load_current_a: 0.45, peak_efficiency: 0.2, r2: 0.999, complete: true, supply_v: 6.0 };
    expect((grade({ ...ref, supply_v: 12.0 }, ref) as { mismatch: string }).mismatch).toMatch(/12\.00 V, the reference at 6\.00 V/);
    expect((grade({ ...ref, supply_v: 6.1 }, ref) as { grade: string }).grade).toBe("A");
  });
});
