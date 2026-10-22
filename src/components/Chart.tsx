// Small SVG charts: lines, scatter and fit lines on numeric axes, and a
// sparkline. Enough for the rig's curves without a charting library in a
// page that has to work offline. Colours come from CSS (.series-N), so the
// charts follow the light and dark themes.

import { useId, useMemo } from "react";
import { useWidth } from "../state/hooks";

export type Point = readonly [number, number];

export interface Series {
  points: readonly Point[];
  style: "line" | "scatter" | "fit";
  /** Colour index, 1-4. */
  n?: number;
}

/** Round tick positions covering [lo, hi], about `count` of them. */
export function niceTicks(lo: number, hi: number, count = 5) {
  if (!(hi > lo)) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, lo: start, hi: end, step };
}

/** A tick label with as many decimals as the step has (0.25 -> 2). */
function fmt(v: number, step: number) {
  const decimals = (Number(step.toPrecision(6)).toString().split(".")[1] ?? "").length;
  return v.toFixed(Math.min(decimals, 4));
}

const finite = ([x, y]: Point) => Number.isFinite(x) && Number.isFinite(y);

export function Chart({
  series,
  xLabel,
  yLabel,
  height = 220,
  xDomain,
  empty = "No data yet",
}: {
  series: Series[];
  xLabel: string;
  yLabel: string;
  height?: number;
  xDomain?: [number, number];
  empty?: string;
}) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const width = Math.max(measured, 240);
  const clipId = useId();

  const geometry = useMemo(() => {
    const all = series.filter((s) => s.style !== "fit").flatMap((s) => s.points.filter(finite));
    if (!all.length) return null;
    const m = { l: 46, r: 10, t: 8, b: 32 };
    const w = width - m.l - m.r;
    const h = height - m.t - m.b;
    const xs = all.map(([x]) => x);
    const ys = all.map(([, y]) => y);
    const xt = niceTicks(...(xDomain ?? [Math.min(...xs), Math.max(...xs)]));
    const yt = niceTicks(Math.min(...ys), Math.max(...ys));
    const sx = (x: number) => m.l + ((x - xt.lo) / (xt.hi - xt.lo)) * w;
    const sy = (y: number) => m.t + h - ((y - yt.lo) / (yt.hi - yt.lo)) * h;
    return { m, w, h, xt, yt, sx, sy };
  }, [series, width, height, xDomain]);

  return (
    <div ref={ref} className="chart-box">
      {!geometry ? (
        <div className="chart-empty" style={{ height }}>
          {empty}
        </div>
      ) : (
        <svg className="chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${yLabel} against ${xLabel}`}>
          {(() => {
            const { m, w, h, xt, yt, sx, sy } = geometry;
            return (
              <>
                <g className="chart-gridlines">
                  {yt.ticks.map((v) => (
                    <line key={`y${v}`} x1={m.l} x2={m.l + w} y1={sy(v)} y2={sy(v)} />
                  ))}
                  {xt.ticks.map((v) => (
                    <line key={`x${v}`} x1={sx(v)} x2={sx(v)} y1={m.t} y2={m.t + h} />
                  ))}
                </g>
                {yt.ticks.map((v) => (
                  <text key={`yl${v}`} x={m.l - 6} y={sy(v) + 3.5} textAnchor="end" className="chart-tick">
                    {fmt(v, yt.step)}
                  </text>
                ))}
                {xt.ticks.map((v) => (
                  <text key={`xl${v}`} x={sx(v)} y={m.t + h + 14} textAnchor="middle" className="chart-tick">
                    {fmt(v, xt.step)}
                  </text>
                ))}
                <text x={m.l + w / 2} y={height - 3} textAnchor="middle" className="chart-axis">
                  {xLabel}
                </text>
                <text x={11} y={m.t + h / 2} textAnchor="middle" className="chart-axis" transform={`rotate(-90 11 ${m.t + h / 2})`}>
                  {yLabel}
                </text>
                <defs>
                  <clipPath id={clipId}>
                    <rect x={m.l} y={m.t} width={w} height={h} />
                  </clipPath>
                </defs>
                <g clipPath={`url(#${clipId})`}>
                  {series.map((s, i) => {
                    const pts = s.points.filter(finite);
                    if (!pts.length) return null;
                    const cls = `series-${s.n ?? 1}`;
                    if (s.style === "scatter")
                      return (
                        <g key={i} className={`chart-scatter ${cls}`}>
                          {pts.map(([x, y], j) => (
                            <circle key={j} cx={sx(x)} cy={sy(y)} r={1.8} />
                          ))}
                        </g>
                      );
                    const d = pts.map(([x, y], j) => `${j ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join("");
                    return (
                      <g key={i}>
                        <path d={d} className={`chart-line ${cls} ${s.style === "fit" ? "chart-fit" : ""}`} />
                        {s.style === "line" && pts.length < 60 && (
                          <g className={`chart-points ${cls}`}>
                            {pts.map(([x, y], j) => (
                              <circle key={j} cx={sx(x)} cy={sy(y)} r={3}>
                                <title>{`${xLabel} ${x.toPrecision(4)}, ${yLabel} ${y.toPrecision(4)}`}</title>
                              </circle>
                            ))}
                          </g>
                        )}
                      </g>
                    );
                  })}
                </g>
              </>
            );
          })()}
        </svg>
      )}
    </div>
  );
}

/** A tiny trend line with no axes, for the rig panel's live readings. */
export function Sparkline({ values, n = 1, height = 28 }: { values: readonly number[]; n?: number; height?: number }) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const width = Math.max(measured, 60);
  const pts = values.filter(Number.isFinite);
  let line = "";
  let area = "";
  if (pts.length > 1) {
    const lo = Math.min(...pts);
    const hi = Math.max(...pts);
    const span = hi - lo || Math.abs(hi) * 0.1 || 1;
    const x = (i: number) => (i / (pts.length - 1)) * width;
    const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4);
    line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    area = `${line}L${width},${height}L0,${height}Z`;
  }
  return (
    <div ref={ref} className="spark">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {area && <path d={area} className={`spark-fill series-${n}`} />}
        {line && <path d={line} className={`spark-line series-${n}`} />}
      </svg>
    </div>
  );
}

/** The two ends of a fitted line across the torques the points cover. */
export function fitLine(fit: { slope: number; intercept: number } | null | undefined, xs: number[]): Point[] {
  if (!fit || !xs.length) return [];
  return [Math.min(0, ...xs), Math.max(...xs)].map((x) => [x, fit.slope * x + fit.intercept] as const);
}
