// The statistics the sweep and the load-cell calibration reduce readings with.
// Ported unchanged from ERC2 Link's rig_test.py, and checked against it.

export interface Summary {
  n: number;
  n_used: number;
  value: number;
  median: number;
  sd: number;
  sem: number;
  min: number;
  max: number;
}

export interface Fit {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

function stdev(values: readonly number[], mean: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1));
}

/**
 * Drop samples further than k median-absolute-deviations from the median.
 * The 0.6745 factor scales MAD to a normal sigma, so k reads like "3σ". A
 * zero MAD -- more than half the samples on exactly one value, as on a
 * stalled shaft reading 0 -- keeps only that value, which is the intent; the
 * floor of three keeps the filter from eating a window it cannot judge.
 */
export function madKeep(values: readonly number[], k: number): number[] {
  if (values.length < 4) return [...values];
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  const limit = (k * mad) / 0.6745;
  const kept = values.filter((v) => Math.abs(v - med) <= limit);
  return kept.length >= 3 ? kept : [...values];
}

export function trimmedMean(values: readonly number[], trim: number): number {
  if (!values.length) return 0;
  let s = [...values].sort((a, b) => a - b);
  const cut = Math.floor(s.length * trim);
  if (cut > 0 && s.length - 2 * cut >= 3) s = s.slice(cut, s.length - cut);
  return s.reduce((a, v) => a + v, 0) / s.length;
}

/** One channel's dwell samples, reduced to a filtered point and its spread. */
export function summarize(values: readonly number[], { mad_k, trim }: { mad_k: number; trim: number }): Summary {
  if (!values.length) return { n: 0, n_used: 0, value: 0, median: 0, sd: 0, sem: 0, min: 0, max: 0 };
  const kept = madKeep(values, mad_k);
  const mean = kept.reduce((a, v) => a + v, 0) / kept.length;
  const sd = stdev(kept, mean);
  return {
    n: values.length,
    n_used: kept.length,
    value: trimmedMean(kept, trim),
    median: median(kept),
    sd,
    sem: sd / Math.sqrt(kept.length),
    min: Math.min(...kept),
    max: Math.max(...kept),
  };
}

/**
 * Least-squares y = slope·x + intercept, with R². A DC motor's TNI curve is
 * linear in torque for both speed and current, so this is what turns the
 * measured steps into the no-load speed and stall torque that get quoted.
 */
export function linearFit(points: readonly (readonly [number, number])[]): Fit | null {
  const pts = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((a, [x]) => a + x, 0) / n;
  const my = pts.reduce((a, [, y]) => a + y, 0) / n;
  const sxx = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  if (sxx <= 0) return null;
  const sxy = pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const sst = pts.reduce((a, [, y]) => a + (y - my) ** 2, 0);
  const ssr = pts.reduce((a, [x, y]) => a + (y - (slope * x + intercept)) ** 2, 0);
  return { slope, intercept, r2: sst > 0 ? 1 - ssr / sst : 1, n };
}
