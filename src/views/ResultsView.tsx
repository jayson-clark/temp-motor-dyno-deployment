import { grade } from "../lib/sweep";
import { useApp, useController } from "../state/hooks";
import { fixed, percent } from "../components/format";

export function ResultsView() {
  const c = useController();
  const results = useApp((s) => s.results);
  const refId = useApp((s) => s.refId);
  const ref = results.find((r) => r.id === refId) ?? null;

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Results</h1>
          <p className="muted">Every finished sweep this session. Mark a reference motor to grade the rest against it.</p>
        </div>
        <div className="toolbar">
          <button className="btn" disabled={!results.length} onClick={() => c.downloadSummary()}>
            Summary CSV
          </button>
          <button
            className="btn"
            disabled={!results.length}
            onClick={() => confirm("Clear this session's results? The CSV files you downloaded are not affected.") && c.clearResults()}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="panel flush">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="c">Ref</th>
                <th className="l">Motor</th>
                <th className="l">Time</th>
                <th>Supply V</th>
                <th>No-load rpm</th>
                <th>Stall N·m</th>
                <th>Peak W</th>
                <th>No-load A</th>
                <th>Eff. %</th>
                <th>R²</th>
                <th>Score</th>
                <th className="c">Grade</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.length === 0 && (
                <tr>
                  <td colSpan={13} className="empty">
                    No sweeps yet. Each finished sweep adds a row here.
                  </td>
                </tr>
              )}
              {results.map((r) => {
                const isRef = r.id === refId;
                const g = isRef ? null : grade(r, ref);
                const gradeCell =
                  g && "mismatch" in g ? (
                    <span className="muted" title={`${g.mismatch}: not comparable`}>
                      other V
                    </span>
                  ) : g ? (
                    <span
                      className={`grade ${g.grade}`}
                      title={`Power ${g.power.toFixed(2)}×, torque ${g.torque.toFixed(2)}×, speed ${g.speed.toFixed(2)}×${g.friction !== null ? `, friction ${g.friction.toFixed(2)}×` : ""}${r.status !== "Complete" ? ` (${r.status.toLowerCase()})` : ""}`}
                    >
                      {g.grade}
                    </span>
                  ) : isRef ? (
                    <span className="badge accent">Reference</span>
                  ) : (
                    <span className="muted">{r.status === "Complete" ? "—" : r.status}</span>
                  );
                return (
                  <tr key={r.id} className={isRef ? "ref" : ""}>
                    <td className="c">
                      <input
                        type="radio"
                        name="ref"
                        checked={isRef}
                        aria-label={`Use ${r.motor || "this motor"} as the reference`}
                        onChange={() => c.setRef(r.id)}
                      />
                    </td>
                    <td className="l strong">{r.motor || "—"}</td>
                    <td className="l muted">{new Date(r.started).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                    <td>{fixed(r.supply_v, 2)}</td>
                    <td>{fixed(r.no_load_rpm, 1)}</td>
                    <td>{fixed(r.stall_torque_nm, 4)}</td>
                    <td>{fixed(r.peak_power_w, 3)}</td>
                    <td>{fixed(r.no_load_current_a, 3)}</td>
                    <td>{percent(r.peak_efficiency)}</td>
                    <td className={r.r2 != null && r.r2 < 0.98 ? "warn-text" : ""}>{fixed(r.r2, 4)}</td>
                    <td>{g && !("mismatch" in g) ? g.score.toFixed(0) : "—"}</td>
                    <td className="c">{gradeCell}</td>
                    <td>
                      <button className="btn ghost sm" onClick={() => c.removeResult(r.id)} aria-label={`Remove ${r.motor || "this result"}`}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <details className="panel explain">
        <summary>How grading works</summary>
        <p>
          The Operator Guide's suggested scheme, against the reference motor, and only between motors run at the same
          supply voltage. Score = (2 × power ratio + torque ratio + speed ratio) ÷ 4 × 100. <b>A</b> ≥ 90 with friction
          ratio ≤ 1.5 and R² ≥ 0.99; <b>B</b> ≥ 75 with friction ≤ 2.0; <b>C</b> ≥ 60; <b>Reject</b> below that, above
          2.5× friction, with R² under 0.98, or after a stall or abort. Friction ratio compares no-load current. Tune the
          thresholds once you have seen 20–30 motors.
        </p>
      </details>
    </div>
  );
}
