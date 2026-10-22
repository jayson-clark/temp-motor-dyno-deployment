/** A number to `digits` places, or an em dash when there isn't one. */
export function fixed(v: number | null | undefined, digits: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  // Noise around zero shouldn't read as "-0.000".
  const s = v.toFixed(digits);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

export function percent(v: number | null | undefined, digits = 1): string {
  return v != null && Number.isFinite(v) ? (v * 100).toFixed(digits) : "—";
}

/** A calibration constant as typed: up to seven significant figures. */
export function calText(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? String(Number(v.toPrecision(7))) : "";
}

export function grouped(v: number): string {
  return Math.round(v).toLocaleString();
}
