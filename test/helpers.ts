import { expect } from "vitest";
import { RigClient } from "../src/lib/rig";
import { SimulatedTransport, type SimulatorOptions } from "../src/lib/simulator";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `a` within `tol` of `b`, saying which quantity it was when it isn't. */
export function close(a: number | null | undefined, b: number, tol: number, what: string) {
  expect(a, what).not.toBeNull();
  expect(Math.abs((a as number) - b), `${what}: ${a} is not within ${tol} of ${b}`).toBeLessThanOrEqual(tol);
}

export async function connectSim(options: SimulatorOptions = {}) {
  const sim = new SimulatedTransport({ latencyMs: 1, ...options });
  const rig = new RigClient(sim);
  await rig.connect();
  return { rig, sim };
}
