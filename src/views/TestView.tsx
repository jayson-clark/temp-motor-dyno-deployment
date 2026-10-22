import { useMemo, useState } from "react";
import { derive, headline, type SweepParams } from "../lib/sweep";
import { onDefaultCalibration } from "../state/controller";
import { useApp, useController } from "../state/hooks";
import { load, save } from "../state/storage";
import { Chart, fitLine, type Series } from "../components/Chart";
import { fixed, percent } from "../components/format";
import type { View } from "../components/TopBar";

const PHASES = { warmup: "Warm-up", settle: "Settling", measure: "Measuring" } as const;

function summary(p: SweepParams): string {
  const parts = [
    p.motor_v > 0 ? `${p.motor_v.toFixed(1)} V` : "any voltage",
    `brake ${p.brake_start}–${p.brake_end}% by ${p.brake_step}`,
    `${p.dwell_s}s dwell`,
    p.load_unit,
  ];
  if (!p.auto_zero) parts.push("no auto-zero");
  return parts.join(" · ");
}

export function TestView({ onView }: { onView: (v: View) => void }) {
  const c = useController();
  const connected = useApp((s) => s.connection.state === "connected");
  const status = useApp((s) => s.status);
  const params = useApp((s) => s.params);
  const run = useApp((s) => s.run);
  const autoDownload = useApp((s) => s.autoDownload);
  const [motorId, setMotorId] = useState(() => load("motorId", ""));
  const [showRaw, setShowRaw] = useState(false);

  const start = () => {
    save("motorId", motorId);
    void c.runSweep(motorId);
  };

  return (
    <div className="view">
      <div className="run-bar">
        <label className="field motor-field">
          <span className="field-label">Motor ID</span>
          <input
            className="input input-lg"
            placeholder="e.g. M-042"
            autoComplete="off"
            value={motorId}
            disabled={run.running}
            onChange={(e) => setMotorId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connected && !run.running && start()}
          />
        </label>
        <div className="run-summary">
          <span className="field-label">Sweep</span>
          <button className="summary-chip" title="Change in Settings" onClick={() => onView("settings")}>
            {summary(params)}
          </button>
        </div>
        <div className="run-actions">
          {run.running ? (
            <button className="btn danger lg" onClick={() => c.cancelSweep()}>
              Cancel
            </button>
          ) : (
            <button className="btn primary lg" disabled={!connected} onClick={start} title={connected ? undefined : "Connect the rig first"}>
              Run sweep
            </button>
          )}
        </div>
      </div>

      {connected && onDefaultCalibration(status) && (
        <div className="callout warn">
          The rig is on the firmware's default calibration, so torque, power and efficiency will be wrong.{" "}
          <button className="link" onClick={() => onView("calibrate")}>
            Calibrate the load cell
          </button>
        </div>
      )}

      <Progress />
      <Headline />
      <Curves showRaw={showRaw} onShowRaw={setShowRaw} />

      <div className="panel">
        <div className="panel-head">
          <h2>Measured points</h2>
          <div className="toolbar">
            <label className="check">
              <input type="checkbox" checked={autoDownload} onChange={(e) => c.setAutoDownload(e.target.checked)} /> Download CSVs
              when done
            </label>
            <button className="btn sm" disabled={!run.result?.steps.length} onClick={() => c.downloadCurve()}>
              Curve CSV
            </button>
            <button className="btn sm" disabled={!run.result?.samples.length} onClick={() => c.downloadRaw()}>
              Raw CSV
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Brake %</th>
                <th>Torque N·m</th>
                <th>Speed rpm</th>
                <th>Current A</th>
                <th>Power W</th>
                <th>Eff. %</th>
                <th>Kept</th>
              </tr>
            </thead>
            <tbody>
              {run.steps.length ? (
                run.steps.map((s) => (
                  <tr key={s.index}>
                    <td>{s.duty}</td>
                    <td>{s.torque.value.toFixed(4)}</td>
                    <td>{s.rpm.value.toFixed(1)}</td>
                    <td>{s.current.value.toFixed(3)}</td>
                    <td>{s.mech_w.toFixed(3)}</td>
                    <td>{(s.efficiency * 100).toFixed(1)}</td>
                    <td className="muted">
                      {s.rpm.n_used}/{s.rpm.n}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="empty">
                    {run.running ? "The first point arrives after the warm-up and one brake step." : "Run a sweep to see its points."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {run.log.length > 0 && (
        <details className="panel log">
          <summary>Run log</summary>
          <pre>{run.log.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

function Progress() {
  const run = useApp((s) => s.run);
  const st = run.state;
  const r = run.result;
  const h = r ? headline(r) : null;

  let pill = { text: "Ready", kind: "" };
  let outcome: { kind: string; text: string } | null = null;
  if (run.running) pill = { text: "Running", kind: "accent" };
  else if (r?.error) {
    pill = { text: "Aborted", kind: "bad" };
    outcome = { kind: "bad", text: `${r.error}. The rig was left with the motor off and the brake released.` };
  } else if (r?.cancelled) {
    pill = { text: "Cancelled", kind: "warn" };
    outcome = { kind: "warn", text: `Cancelled after ${r.steps.length} steps.` };
  } else if (r && h?.r2 != null && h.r2 < 0.98) {
    pill = { text: "Check", kind: "warn" };
    outcome = {
      kind: "warn",
      text: `Complete, but the speed fit's R² is ${h.r2.toFixed(3)} (under 0.98). Check the rig, or re-seat the motor and test again before grading it.`,
    };
  } else if (r) {
    pill = { text: r.stalled ? "Stalled" : "Complete", kind: r.stalled ? "warn" : "ok" };
    outcome = {
      kind: r.stalled ? "warn" : "ok",
      text: r.stalled
        ? `The motor stalled during the sweep, after ${r.steps.length} points.`
        : `${r.motor_id ? `${r.motor_id}: ` : ""}${r.steps.length} points from ${r.sample_count} samples (${r.rejected} rejected by the filter), in ${r.duration_s.toFixed(0)} s.`,
    };
  }

  const total = st?.steps_total || 1;
  const done = !st ? 0 : st.phase === "warmup" ? 0 : st.step + (st.phase === "measure" ? 0.5 : 0);
  const pct = r && !r.error && !r.cancelled ? 100 : Math.min(100, (done / total) * 100);

  return (
    <div className="panel">
      <div className="progress-row">
        <span className={`badge ${pill.kind}`}>{pill.text}</span>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${pct.toFixed(1)}%` }} />
        </div>
        <dl className="inline-stats">
          <dt>Phase</dt>
          <dd>{run.running ? (st ? PHASES[st.phase] : "Starting") : r ? "Done" : "—"}</dd>
          <dt>Step</dt>
          <dd>{st && st.phase !== "warmup" ? `${st.step + 1} of ${total}` : "—"}</dd>
          <dt>Brake</dt>
          <dd>{st ? `${st.duty}%` : "—"}</dd>
          <dt>Elapsed</dt>
          <dd>{st ? `${st.elapsed.toFixed(1)} s` : "—"}</dd>
          <dt>Samples</dt>
          <dd>{st ? st.samples : "—"}</dd>
        </dl>
      </div>
      {outcome && !run.running && <div className={`callout ${outcome.kind}`}>{outcome.text}</div>}
    </div>
  );
}

function Headline() {
  const run = useApp((s) => s.run);
  const h = run.result ? headline(run.result) : null;
  const kpis = [
    { label: "No-load speed", value: fixed(h?.no_load_rpm, 1), unit: "rpm" },
    { label: "Stall torque", value: fixed(h?.stall_torque_nm, 4), unit: "N·m" },
    { label: "Peak power", value: fixed(h?.peak_power_w, 3), unit: "W" },
    { label: "No-load current", value: fixed(h?.no_load_current_a, 3), unit: "A" },
    { label: "Peak efficiency", value: percent(h?.peak_efficiency), unit: "%" },
    { label: "Fit R²", value: fixed(h?.r2, 4), unit: "speed line", warn: h?.r2 != null && h.r2 < 0.98 },
  ];
  return (
    <div className="kpis">
      {kpis.map((k) => (
        <div className={`kpi ${k.warn ? "warn" : ""}`} key={k.label}>
          <span className="kpi-label">{k.label}</span>
          <span className="kpi-value">{k.value}</span>
          <span className="kpi-unit">{k.unit}</span>
        </div>
      ))}
    </div>
  );
}

function Curves({ showRaw, onShowRaw }: { showRaw: boolean; onShowRaw: (v: boolean) => void }) {
  const run = useApp((s) => s.run);
  const steps = run.result ? run.result.steps : run.steps;
  const samples = run.result ? run.result.samples.filter((s) => s.phase === "measure") : run.samples;
  const derived = useMemo(() => (run.result ? run.result.derived : derive(steps)), [run.result, steps]);
  const torques = steps.map((s) => s.torque.value);
  const empty = run.running ? "Measuring…" : "No sweep yet";

  const make = (pick: (s: (typeof steps)[number]) => number, raw: ((s: (typeof samples)[number]) => number) | null, fit: typeof derived.speed_fit, n: number): Series[] => {
    const series: Series[] = [];
    if (showRaw && raw) series.push({ points: samples.map((s) => [s.torque, raw(s)] as const), style: "scatter", n });
    series.push({ points: steps.map((s) => [s.torque.value, pick(s)] as const), style: "line", n });
    if (fit) series.push({ points: fitLine(fit, torques), style: "fit", n });
    return series;
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Performance curves</h2>
        <label className="check">
          <input type="checkbox" checked={showRaw} onChange={(e) => onShowRaw(e.target.checked)} /> Raw samples
        </label>
      </div>
      <div className="chart-grid">
        <figure>
          <figcaption>Speed vs torque</figcaption>
          <Chart xLabel="Torque (N·m)" yLabel="Speed (rpm)" empty={empty} series={make((s) => s.rpm.value, (s) => s.rpm, derived.speed_fit, 1)} />
        </figure>
        <figure>
          <figcaption>Current vs torque</figcaption>
          <Chart xLabel="Torque (N·m)" yLabel="Current (A)" empty={empty} series={make((s) => s.current.value, (s) => s.current, derived.current_fit, 2)} />
        </figure>
        <figure>
          <figcaption>Shaft power vs torque</figcaption>
          <Chart xLabel="Torque (N·m)" yLabel="Shaft power (W)" empty={empty} series={make((s) => s.mech_w, (s) => s.mech_w, null, 3)} />
        </figure>
        <figure>
          <figcaption>Efficiency vs torque</figcaption>
          <Chart xLabel="Torque (N·m)" yLabel="Efficiency (%)" empty={empty} series={make((s) => s.efficiency * 100, null, null, 4)} />
        </figure>
      </div>
    </div>
  );
}
