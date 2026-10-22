// Calibrating the rig without doing sums.
//
// Load cell: the rig reports load = (raw − tare) / counts_per_unit, in
// whatever unit the span was worked out in. Calibrating with a known mass at
// a known distance from the generator shaft gives a known torque, so the span
// is worked out in a torque unit: where the load cell itself sits on the arm
// never enters into it, and the sweep's lever-arm setting is not needed.
//
// Encoder: counts per revolution, from turning the shaft a known number of
// times.

import { median, summarize } from "./stats";
import type { LoadUnit } from "./sweep";

const G = 9.80665;
export const TORQUE_UNITS = ["kg·cm", "N·m"] as const;
export type TorqueUnit = (typeof TORQUE_UNITS)[number];
// The HX711 is a 24-bit converter: readings pinned near ±2^23 mean the cell
// is at the end of its range and the number is not a measurement.
const HX711_LIMIT = 8_388_607;

/** The torque unit to calibrate in: the sweep's, if it is one, else kg·cm. */
export function torqueUnit(sweepUnit: LoadUnit): TorqueUnit {
  return (TORQUE_UNITS as readonly string[]).includes(sweepUnit) ? (sweepUnit as TorqueUnit) : "kg·cm";
}

/** The torque a mass in grams exerts at a distance in millimetres. */
export function torqueFromHang(massG: number, armMm: number, unit: TorqueUnit): number {
  if (unit === "N·m") return (massG / 1000) * G * (armMm / 1000);
  return (massG / 1000) * (armMm / 10); // kg·cm
}

export type SpanResult =
  | { error: string }
  | { countsPerUnit: number; known: number; raw: number; spread: number; n: number; unit: TorqueUnit };

/**
 * Counts per unit from the tared readings taken with the weight hung, or an
 * error with a sentence saying what to fix.
 */
export function span({ rawReadings, massG, armMm, unit }: {
  rawReadings: readonly number[];
  massG: number;
  armMm: number;
  unit: TorqueUnit;
}): SpanResult {
  if (!(massG > 0)) return { error: "Enter the mass you hung, in grams." };
  if (!(armMm > 0)) return { error: "Enter the distance from the shaft centre to the weight, in millimetres." };
  if (rawReadings.length < 5) return { error: "Not enough load-cell readings came in. Is the rig connected?" };

  // The rig only reports the reading less the tare, so this catches a cell
  // driven to the end of its range from somewhere near zero. A saturated
  // HX711 sends the same pinned number every time, so this comes first.
  if (median(rawReadings.map(Math.abs)) >= HX711_LIMIT * 0.98)
    return { error: "The load cell is at the end of its range. Use a lighter weight, or hang it closer to the shaft." };
  // Otherwise the HX711 always jitters by a few counts. The same number every
  // time means it has stopped publishing and these are one stale reading.
  if (new Set(rawReadings).size === 1)
    return {
      error:
        "The load cell's reading isn't changing at all, so it has stopped sending new readings. " +
        "Check the HX711's wiring (SCK on pin 11, DT on pin 12).",
    };

  const s = summarize(rawReadings, { mad_k: 3.5, trim: 0.2 });
  const raw = s.value;
  const known = torqueFromHang(massG, armMm, unit);

  // A change smaller than the jitter is no change at all.
  if (Math.abs(raw) < Math.max(200, 6 * s.sd))
    return {
      error:
        "The reading barely moved from the tare. Check the weight is hanging freely from the arm, " +
        "the arm is resting on the load cell, and the cell is wired.",
    };
  if (s.sd > Math.abs(raw) * 0.02)
    return { error: "The readings are too unsteady to trust. Let the weight stop swinging, then measure again." };

  return { countsPerUnit: raw / known, known, raw, spread: s.sd, n: s.n_used, unit };
}

export type EncoderResult = { error: string } | { countsPerRev: number };

/** Counts per revolution from the count after turning the shaft `turns` times. */
export function encoderSpan(counts: number, turns: number): EncoderResult {
  if (!(turns >= 1)) return { error: "Enter how many whole turns you made." };
  if (counts <= 0) return { error: "The encoder hasn't counted anything. Reset it, turn the shaft, then apply." };
  if (counts / turns < 10) return { error: "Too few counts for that many turns. Check the encoder wiring (pin 8)." };
  return { countsPerRev: counts / turns };
}
