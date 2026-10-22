import { describe, expect, test } from "vitest";
import { Controller } from "../src/state/controller";
import { SimulatedTransport } from "../src/lib/simulator";
import { sleep } from "./helpers";

// The spread of successive values: how much a number visibly jumps around.
const jitter = (values: number[]) => {
  const steps = values.slice(1).map((v, i) => Math.abs(v - values[i]));
  return steps.reduce((a, v) => a + v, 0) / steps.length;
};

describe("the controller", () => {
  test("the rig panel's readings are smoothed, and a glitched reading never shows", async () => {
    const c = new Controller();
    // A supply that glitches far more often than the real one.
    await (c as unknown as { connectWith(t: SimulatedTransport): Promise<boolean> }).connectWith(
      new SimulatedTransport({ latencyMs: 1, glitchRate: 0.1 }),
    );
    try {
      await c.setMotor(true);
      c.pushBrake(40);
      await sleep(2500); // spin up and fill the window
      const raw: number[] = [];
      const shown: number[] = [];
      const supply: number[] = [];
      const unsub = c.subscribe(() => {
        const st = c.getState();
        raw.push(st.status!.rpm);
        shown.push(st.smoothed!.rpm!);
        supply.push(st.smoothed!.supplyV!);
      });
      await sleep(3000);
      unsub();
      expect(raw.length).toBeGreaterThan(10);
      expect(jitter(shown), "smoothed speed jumps far less than the raw").toBeLessThan(jitter(raw) / 3);
      // Raw readings dip to ~4.6 V on a glitch; the shown supply never does.
      expect(Math.min(...supply)).toBeGreaterThan(5.2);
    } finally {
      await c.disconnect();
    }
  });
});
