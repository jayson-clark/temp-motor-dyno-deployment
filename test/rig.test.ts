import { describe, expect, test } from "vitest";
import { median } from "../src/lib/stats";
import { close, connectSim, sleep } from "./helpers";

describe("the rig client, against the simulator", () => {
  test("it identifies the rig and drives it", async () => {
    const { rig } = await connectSim();
    try {
      expect(rig.version).toBe("motorrig-1.3");
      expect(rig.status, "a status arrives during connect").not.toBeNull();
      await rig.setMotor(true);
      await rig.setBrake(40);
      await sleep(600);
      const s = (await rig.requestStatus())!;
      expect(s.motorOn).toBe(true);
      expect(s.brake).toBe(40);
      expect(s.rpm, "spinning").toBeGreaterThan(20);
      expect(await rig.scanI2c()).toEqual([0x40, 0x41]);
      await rig.setCalibration(2000, 1000);
      await sleep(20);
      expect(rig.status!.countsPerRev).toBe(2000);
      await rig.estop();
      await sleep(20);
      expect(rig.status!.motorOn).toBe(false);
      expect(rig.status!.brake).toBe(0);
    } finally {
      await rig.close();
    }
  });

  test("taring zeroes the load cell", async () => {
    const { rig } = await connectSim();
    try {
      expect(Math.abs(rig.status!.load), "untared offset").toBeGreaterThan(1);
      await rig.tare();
      await sleep(2000); // 16 samples at the HX711's 10 Hz
      const loads: number[] = [];
      for (let i = 0; i < 5; i++) {
        const s = (await rig.requestStatus())!;
        expect(s.taring).toBe(false);
        loads.push(s.load);
        await sleep(110);
      }
      // The simulated cell has 0.01 kg·cm of noise; the median shrugs off a spike.
      close(median(loads), 0, 0.05, "tared load (kg·cm)");
    } finally {
      await rig.close();
    }
  });
});
