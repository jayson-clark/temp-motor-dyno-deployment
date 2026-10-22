import { describe, expect, test } from "vitest";
import * as P from "../src/lib/protocol";
import { SimulatedTransport } from "../src/lib/simulator";
import { close } from "./helpers";

describe("protocol", () => {
  test("a frame encodes as sync, command, length, payload", () => {
    expect([...P.encode(P.CMD.RIG_BRAKE, [42])]).toEqual([0xab, 0xcd, 0x52, 1, 42]);
    expect([...P.encode(P.CMD.RIG_STATUS)]).toEqual([0xab, 0xcd, 0x50, 0]);
    expect(() => P.encode(P.CMD.RIG_SET_CAL, new Uint8Array(51))).toThrow(/too long/);
  });

  test("the decoder resyncs after junk and reassembles split frames", () => {
    const d = new P.FrameDecoder();
    const version = P.encode(P.RSP.VERSION, new TextEncoder().encode("motorrig-1.1"));
    const status = P.frame(P.RSP.RIG_STATUS, new Uint8Array(P.STATUS_BYTES));
    const stream = new Uint8Array([0x00, 0xab, 0x12, 0xab, ...version, ...status, ...P.encode(P.RSP.PONG)]);
    const frames: P.Frame[] = [];
    for (let i = 0; i < stream.length; i += 3) frames.push(...d.push(stream.subarray(i, i + 3)));
    expect(frames).toHaveLength(3);
    expect(P.parseVersion(frames[0].payload)).toBe("motorrig-1.1");
    expect(frames[1].payload.length, "a 54-byte reply decodes whole").toBe(P.STATUS_BYTES);
    expect(frames[2].cmd).toBe(P.RSP.PONG);
  });

  test("status parses both the 54-byte and the older 46-byte frame", () => {
    const full = new SimulatedTransport({ now: () => 0 }).statusPayload();
    const s = P.parseStatus(full)!;
    expect(s.countsPerRev).toBe(P.DEFAULT_CALIBRATION.countsPerRev);
    close(s.countsPerUnit, P.DEFAULT_CALIBRATION.countsPerUnit, 0.5, "counts/unit");
    expect(s.inaTestOk).toBe(true);
    const old = P.parseStatus(full.subarray(0, 46))!;
    expect(old.countsPerRev).toBeNull();
    expect(old.batteryV).toBe(s.batteryV);
    expect(P.parseStatus(full.subarray(0, 40))).toBeNull();
  });

  test("calibration and I2C payloads round-trip", () => {
    const v = new DataView(P.calibrationPayload(1398, -390000).buffer);
    expect(v.getFloat32(0, true)).toBe(1398);
    expect(v.getFloat32(4, true)).toBe(-390000);
    expect(P.parseI2c(Uint8Array.from([2, 0x40, 0x41]))).toEqual([0x40, 0x41]);
    expect(P.parseI2c(Uint8Array.from([5, 0x40]))).toEqual([0x40]); // count longer than the frame
    expect(P.isRigVersion("motorrig-1.1") && P.isRigVersion("MotorRig-2")).toBe(true);
    expect(P.isRigVersion("ERC2 2.2.1")).toBe(false);
  });
});
