import { describe, expect, test } from "vitest";
import { encoderSpan, span, torqueFromHang, torqueUnit } from "../src/lib/calibration";
import { MOTOR } from "../src/lib/simulator";
import { median } from "../src/lib/stats";
import { close, connectSim, sleep } from "./helpers";

describe("calibrating the load cell", () => {
  test("a hung weight's torque, in either torque unit", () => {
    close(torqueFromHang(200, 38, "kg·cm"), 0.76, 1e-12, "kg·cm");
    close(torqueFromHang(200, 38, "N·m"), 0.2 * 9.80665 * 0.038, 1e-12, "N·m");
    expect(torqueUnit("g")).toBe("kg·cm");
    expect(torqueUnit("N·m")).toBe("N·m");
  });

  test("the span is the tared counts over the known torque, and its sign follows the cell", () => {
    const steady = (v: number) => Array.from({ length: 20 }, (_, i) => v + (i % 3) - 1);
    const r = span({ rawReadings: steady(296_400), massG: 200, armMm: 38, unit: "kg·cm" });
    if ("error" in r) throw new Error(r.error);
    close(r.countsPerUnit, 390_000, 5, "counts per kg·cm");
    // A cell mounted the other way round reads negative, and so does its span:
    // load = counts / span then comes out positive under the brake anyway.
    const neg = span({ rawReadings: steady(-296_400), massG: 200, armMm: 38, unit: "kg·cm" });
    expect("countsPerUnit" in neg && neg.countsPerUnit < 0).toBe(true);
  });

  test("it refuses readings it can't trust, and says why", () => {
    const err = (o: Partial<Parameters<typeof span>[0]>) => {
      const r = span({ rawReadings: [], massG: 200, armMm: 38, unit: "kg·cm", ...o });
      return "error" in r ? r.error : "";
    };
    expect(err({ rawReadings: Array(20).fill(300_000), massG: 0 })).toMatch(/mass/);
    expect(err({ rawReadings: Array(20).fill(300_000), armMm: 0 })).toMatch(/distance/);
    expect(err({ rawReadings: [1, 2] })).toMatch(/Not enough/);
    expect(err({ rawReadings: Array.from({ length: 20 }, () => 40 + Math.random() * 20) })).toMatch(/barely moved/);
    expect(err({ rawReadings: Array(20).fill(8_388_607) })).toMatch(/end of its range/);
    expect(err({ rawReadings: Array(20).fill(296_400) })).toMatch(/isn't changing at all/);
    expect(err({ rawReadings: Array.from({ length: 20 }, (_, i) => 300_000 + (i % 2 ? 40_000 : -40_000)) })).toMatch(/unsteady/);
  });

  test("from a hung weight against the simulator, it recovers the cell", async () => {
    const { rig, sim } = await connectSim();
    try {
      await rig.tare();
      await sleep(2000);
      sim.hang(200, 38);
      await sleep(300); // a new HX711 reading or two
      const readings: number[] = [];
      const off = rig.on("status", (s) => s.loadValid && !s.taring && readings.push(s.loadRaw));
      await sleep(2500);
      off();
      const r = span({ rawReadings: readings, massG: 200, armMm: 38, unit: "kg·cm" });
      if ("error" in r) throw new Error(r.error);
      close(r.countsPerUnit / MOTOR.countsPerKgCm, 1, 0.01, "span vs the cell's true sensitivity");

      await rig.setCalibration(rig.status!.countsPerRev!, r.countsPerUnit);
      await sleep(300);
      const loads: number[] = [];
      for (let i = 0; i < 5; i++) {
        loads.push((await rig.requestStatus())!.load);
        await sleep(110);
      }
      close(median(loads), 0.76, 0.02, "the hung weight, read back in kg·cm");
    } finally {
      await rig.close();
    }
  });
});

describe("calibrating the encoder", () => {
  test("counts per rev from a number of turns", () => {
    expect(encoderSpan(13980, 10)).toEqual({ countsPerRev: 1398 });
    expect(encoderSpan(13980, 0)).toHaveProperty("error");
    expect(encoderSpan(0, 10)).toHaveProperty("error");
    expect(encoderSpan(30, 10)).toHaveProperty("error");
  });

  test("turning the simulated shaft recovers its counts per rev", async () => {
    const { rig, sim } = await connectSim();
    try {
      await rig.resetEncoder();
      await sleep(50);
      sim.turnShaft(10);
      const s = (await rig.requestStatus())!;
      const r = encoderSpan(s.counts, 10);
      if ("error" in r) throw new Error(r.error);
      close(r.countsPerRev, sim.countsPerRev, 0.5, "counts per rev");
    } finally {
      await rig.close();
    }
  });
});
