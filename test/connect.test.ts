import { describe, expect, test } from "vitest";
import * as P from "../src/lib/protocol";
import { RigClient, type ConnectPhase } from "../src/lib/rig";
import { SimulatedTransport } from "../src/lib/simulator";
import { sleep } from "./helpers";

// Opening the port restarts the board: bootloader, then the library's
// start-up, then the rig. These check the client gets through that.
describe("connecting through the board's restart", () => {
  test("it sends nothing until the rig says it is ready", async () => {
    // A Mega's bootloader waits for an upload while bytes keep arriving, so a
    // client that asks straight away keeps the board there for good.
    const sim = new SimulatedTransport({ latencyMs: 1 });
    const writes: boolean[] = [];
    const write = sim.write.bind(sim);
    sim.write = (bytes) => {
      writes.push(sim.ready);
      return write(bytes);
    };
    const phases: ConnectPhase[] = [];
    const rig = new RigClient(sim);
    try {
      expect(await rig.connect({ onProgress: (p) => phases.push(p) })).toBe("motorrig-1.3");
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every(Boolean), "every write came after the rig was ready").toBe(true);
      expect(phases).toEqual(["restarting", "starting"]);
    } finally {
      await rig.close();
    }
  });

  test("a client that asks straight away keeps the board in its bootloader", async () => {
    // The bug this design is for, reproduced against the simulated bootloader.
    const sim = new SimulatedTransport({ latencyMs: 1 });
    await sim.open();
    const timer = setInterval(() => sim.write(P.encode(P.CMD.VERSION)), 50);
    await sleep(1500);
    clearInterval(timer);
    expect(sim.inBootloader).toBe(true);
    await sim.close();
  });

  test("rig firmware older than 1.2 is asked once start-up finishes", async () => {
    const phases: ConnectPhase[] = [];
    const rig = new RigClient(new SimulatedTransport({ latencyMs: 1, announce: false, version: "motorrig-1.1" }));
    try {
      expect(await rig.connect({ onProgress: (p) => phases.push(p) })).toBe("motorrig-1.1");
      expect(phases).toEqual(["restarting", "starting", "identifying"]);
    } finally {
      await rig.close();
    }
  });

  test("a rig built on an older library is found at 115200 baud", async () => {
    const bauds: number[] = [];
    const rig = new RigClient(new SimulatedTransport({ latencyMs: 1, baud: 115200 }));
    try {
      await rig.connect({ onProgress: (p, baud) => p === "restarting" && bauds.push(baud) });
      expect(bauds).toEqual([500000, 115200]);
      expect(rig.status).not.toBeNull();
    } finally {
      await rig.close();
    }
  });

  test("with the battery off it says so, and connects once it comes on", async () => {
    const sim = new SimulatedTransport({ latencyMs: 1, batteryOn: false });
    const phases: ConnectPhase[] = [];
    const rig = new RigClient(sim);
    try {
      const version = await rig.connect({
        onProgress: (p) => {
          phases.push(p);
          if (p === "waiting-power") setTimeout(() => sim.powerOn(), 300);
        },
        timing: { powerHintMs: 400 },
      });
      expect(version).toBe("motorrig-1.3");
      expect(phases).toContain("waiting-power");
    } finally {
      await rig.close();
    }
  });

  test("another board's firmware is refused by name", async () => {
    const other = new SimulatedTransport({ latencyMs: 1, version: "tester-1.0" });
    await expect(new RigClient(other).connect()).rejects.toThrow(/running "tester-1.0", not the motor-rig firmware/);
  });

  test("an ERC2 running an ordinary program is told apart", async () => {
    // Its link agent answers a frame without a CRC with a CRC'd error.
    const erc2 = new SimulatedTransport({ latencyMs: 1, announce: false });
    erc2.handle = function (this: SimulatedTransport) {
      this.send(0x81, Uint8Array.from([0x07]));
    };
    await expect(new RigClient(erc2).connect()).rejects.toThrow(/ordinary ERC2 program/);
  });

  test("a board that sends nothing at all says to check the cable and the port", async () => {
    const dead = new SimulatedTransport({ latencyMs: 1 });
    (dead as unknown as { leaveBootloader: () => void }).leaveBootloader = () => {};
    await expect(new RigClient(dead).connect({ timing: { silentMs: 300, probes: 2, probeMs: 100 } })).rejects.toThrow(
      /Nothing at all came from the board/,
    );
  });

  test("a board that starts but never answers says to upload the firmware", async () => {
    const quiet = new SimulatedTransport({ latencyMs: 1, announce: false });
    quiet.handle = () => {};
    await expect(new RigClient(quiet).connect({ bauds: [500000], timing: { probes: 2, probeMs: 100 } })).rejects.toThrow(
      /started up, but the motor-rig firmware didn't answer/,
    );
  });
});
