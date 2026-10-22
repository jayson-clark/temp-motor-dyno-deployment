import { useEffect, useState } from "react";
import { encoderSpan, span, torqueUnit, type SpanResult } from "../lib/calibration";
import { DEFAULT_CALIBRATION, KNOWN_I2C } from "../lib/protocol";
import { onDefaultCalibration } from "../state/controller";
import { useApp, useController } from "../state/hooks";
import { load, save } from "../state/storage";
import { calText, grouped } from "../components/format";

// How long Measure listens to the load cell, which publishes at ~10 Hz.
const SPAN_MEASURE_MS = 2500;
const DEFAULT_ARM_MM = 38;

export function CalibrateView() {
  const status = useApp((s) => s.status);
  const note = useApp((s) => s.calibrationNote);
  const connected = useApp((s) => s.connection.state === "connected");
  const known = status?.countsPerRev != null;
  const defaults = onDefaultCalibration(status);

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Calibrate</h1>
          <p className="muted">
            {note ?? "Calibration is stored on the rig (firmware 1.3 and later), so it only needs doing once per rig."}
          </p>
        </div>
        {connected && (
          <span className={`badge ${!known ? "" : defaults ? "warn" : "ok"}`}>
            {!known ? "Unknown" : defaults ? "Firmware defaults" : "Calibrated"}
          </span>
        )}
      </div>

      {!connected && <div className="callout">Connect the rig to calibrate it.</div>}

      <div className="cal-grid">
        <LoadCellPanel />
        <div className="stack">
          <EncoderPanel />
          <ValuesPanel />
          <I2cPanel />
        </div>
      </div>
    </div>
  );
}

function LoadCellPanel() {
  const c = useController();
  const connected = useApp((s) => s.connection.state === "connected");
  const status = useApp((s) => s.status);
  const sweepUnit = useApp((s) => s.params.load_unit);
  const running = useApp((s) => s.run.running);
  const busy = !connected || running;
  const [mass, setMass] = useState<string>(() => String(load("span.massG", "") ?? ""));
  const [arm, setArm] = useState<string>(() => String(load("span.armMm", DEFAULT_ARM_MM)));
  const [tare, setTare] = useState<{ kind: string; text: string } | null>(null);
  const [measuring, setMeasuring] = useState<string | null>(null);
  const [result, setResult] = useState<SpanResult | null>(null);
  const [applied, setApplied] = useState<{ value: number; unit: string } | null>(null);
  const [check, setCheck] = useState<number | null>(null);

  // After applying, show the live reading beside what it should be: the
  // median of the last second, so one noisy reading isn't mistaken for a bad
  // calibration.
  useEffect(() => {
    if (!applied || !connected) return;
    let alive = true;
    const tick = async () => {
      const m = await c.medianLoad(1000);
      if (alive) {
        setCheck(m);
        void tick();
      }
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [applied, connected, c]);

  const reset = () => {
    setResult(null);
    setApplied(null);
    setCheck(null);
  };

  const doTare = async () => {
    reset();
    setTare({ kind: "", text: "Taring…" });
    const ok = await c.tareAndWait();
    const s = c.getState().status;
    setTare(
      ok && s?.loadValid
        ? { kind: "ok", text: `Tared (now ${grouped(s.loadRaw)} counts)` }
        : { kind: "bad", text: "The tare didn't finish: the load cell isn't sending new readings. Check the HX711's wiring (SCK pin 11, DT pin 12)." },
    );
  };

  const measure = async () => {
    reset();
    if (status?.motorOn) return setResult({ error: "Stop the test motor first: calibrate with the rig still." });
    if (status?.taring) {
      setMeasuring("Waiting for the tare to finish…");
      if (!(await c.waitForTare())) {
        setMeasuring(null);
        return setResult({ error: "The tare never finished: the load cell isn't sending new readings. Check the HX711's wiring (SCK pin 11, DT pin 12)." });
      }
    }
    setMeasuring("Reading the load cell…");
    const readings = await c.collectLoadRaw(SPAN_MEASURE_MS);
    setMeasuring(null);
    setResult(span({ rawReadings: readings, massG: Number(mass), armMm: Number(arm), unit: torqueUnit(sweepUnit) }));
  };

  const apply = async () => {
    if (!result || "error" in result) return;
    const cpr = c.getState().status?.countsPerRev ?? DEFAULT_CALIBRATION.countsPerRev;
    const err = await c.applyCalibration(cpr, result.countsPerUnit);
    if (err) return setResult({ error: err });
    if (sweepUnit !== result.unit) c.setParams({ load_unit: result.unit });
    setApplied({ value: result.known, unit: result.unit });
  };

  const unit = torqueUnit(sweepUnit);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Load cell</h2>
        <span className="muted small">from a hung weight</span>
      </div>
      <ol className="steps">
        <li>
          <div className="step-title">Zero it</div>
          <p className="muted small">Motor off, with the arm resting on the load cell as it does in a test and nothing hanging from it.</p>
          <div className="step-actions">
            <button className="btn" disabled={busy || tare?.text === "Taring…"} onClick={() => void doTare()}>
              Tare
            </button>
            {tare && <span className={`step-state ${tare.kind}`}>{tare.kind === "ok" ? "✓ " : ""}{tare.text}</span>}
          </div>
        </li>
        <li>
          <div className="step-title">Hang a known weight</div>
          <p className="muted small">
            On the side that presses the arm into the cell. Let it stop swinging. Measure the distance horizontally from
            the centre of the generator shaft.
          </p>
          <div className="form-row">
            <label className="field">
              <span className="field-label">Mass</span>
              <span className="input-unit">
                <input
                  className="input"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="200"
                  value={mass}
                  onChange={(e) => {
                    setMass(e.target.value);
                    save("span.massG", e.target.value);
                    reset();
                  }}
                />
                <span>g</span>
              </span>
            </label>
            <label className="field">
              <span className="field-label">Distance from shaft</span>
              <span className="input-unit">
                <input
                  className="input"
                  type="number"
                  min={0}
                  step="any"
                  value={arm}
                  onChange={(e) => {
                    setArm(e.target.value);
                    save("span.armMm", e.target.value);
                    reset();
                  }}
                />
                <span>mm</span>
              </span>
            </label>
          </div>
        </li>
        <li>
          <div className="step-title">Measure and apply</div>
          <div className="step-actions">
            <button className="btn" disabled={busy || !!measuring} onClick={() => void measure()}>
              Measure
            </button>
            {measuring && (
              <span className="muted small">
                <span className="spinner" /> {measuring}
              </span>
            )}
          </div>
          {result && "error" in result && <div className="callout bad">{result.error}</div>}
          {result && !("error" in result) && (
            <div className="callout ok">
              <dl className="result-list">
                <dt>Load cell</dt>
                <dd>
                  {grouped(result.raw)} counts above the tare (±{grouped(result.spread)}, {result.n} readings)
                </dd>
                <dt>Known torque</dt>
                <dd>
                  {result.known.toPrecision(4)} {result.unit} ({mass} g at {arm} mm)
                </dd>
                <dt>Load counts / unit</dt>
                <dd className="strong">
                  {Number(result.countsPerUnit.toPrecision(6)).toLocaleString()} per {result.unit}
                </dd>
              </dl>
              {sweepUnit !== result.unit && (
                <p className="small">Applying also sets the sweep's load cell unit from {sweepUnit} to {result.unit}, so the two match.</p>
              )}
            </div>
          )}
          {result && !("error" in result) && !applied && (
            <div className="step-actions">
              <button className="btn primary" disabled={busy} onClick={() => void apply()}>
                Apply calibration
              </button>
            </div>
          )}
          {applied && (
            <p className="check-line">
              Now reading <b>{check != null ? check.toPrecision(4) : "…"} {applied.unit}</b>; the weight should read{" "}
              <b>
                {applied.value.toPrecision(4)} {unit}
              </b>
              . Take it off and the reading should go back to about 0.
            </p>
          )}
        </li>
      </ol>
    </div>
  );
}

function EncoderPanel() {
  const c = useController();
  const connected = useApp((s) => s.connection.state === "connected");
  const running = useApp((s) => s.run.running);
  const busy = !connected || running;
  const counts = useApp((s) => s.status?.counts ?? null);
  const [turns, setTurns] = useState("10");
  const [state, setState] = useState<{ kind: string; text: string } | null>(null);

  const apply = async () => {
    const r = encoderSpan(counts ?? 0, Number(turns));
    if ("error" in r) return setState({ kind: "bad", text: r.error });
    const cpu = c.getState().status?.countsPerUnit ?? DEFAULT_CALIBRATION.countsPerUnit;
    const err = await c.applyCalibration(r.countsPerRev, cpu);
    setState(err ? { kind: "bad", text: err } : { kind: "ok", text: `✓ Applied ${+r.countsPerRev.toPrecision(6)} counts / rev` });
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Encoder</h2>
        <span className="muted small">by turning the shaft</span>
      </div>
      <ol className="steps">
        <li>
          <div className="step-title">Reset the count</div>
          <div className="step-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                setState(null);
                void c.resetEncoder();
              }}
            >
              Reset encoder
            </button>
            <span className="muted small">
              Now <b className="mono">{counts != null ? counts.toLocaleString() : "—"}</b> counts
            </span>
          </div>
        </li>
        <li>
          <div className="step-title">Turn the generator output shaft by hand</div>
          <p className="muted small">Whole turns against a mark, motor off. More turns, better accuracy, up to about 40.</p>
          <div className="form-row">
            <label className="field">
              <span className="field-label">Turns</span>
              <span className="input-unit">
                <input className="input" type="number" min={1} step={1} value={turns} onChange={(e) => setTurns(e.target.value)} />
                <span>rev</span>
              </span>
            </label>
          </div>
        </li>
        <li>
          <div className="step-title">Apply</div>
          <div className="step-actions">
            <button className="btn" disabled={busy} onClick={() => void apply()}>
              Apply counts / rev
            </button>
            {state && <span className={`step-state ${state.kind}`}>{state.text}</span>}
          </div>
        </li>
      </ol>
    </div>
  );
}

/**
 * The two constants the rig is running, editable directly. The rig reports
 * them in every frame, so a field mirroring it would overwrite a number
 * mid-keystroke: a field follows the rig only while it is untouched.
 */
function ValuesPanel() {
  const c = useController();
  const status = useApp((s) => s.status);
  const connected = useApp((s) => s.connection.state === "connected");
  const running = useApp((s) => s.run.running);
  const busy = !connected || running;
  const [rev, setRev] = useState<string | null>(null);
  const [unit, setUnit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const edited = rev !== null || unit !== null;
  const saved = c.savedCalibration();
  const savedDiffers =
    saved && status?.countsPerRev != null && status.countsPerUnit != null &&
    (Math.abs(saved.countsPerRev - status.countsPerRev) > 1e-3 || Math.abs(saved.countsPerUnit / status.countsPerUnit - 1) > 1e-6);

  const apply = async (cpr: number, cpu: number) => {
    const err = await c.applyCalibration(cpr, cpu);
    setError(err);
    if (!err) {
      setRev(null);
      setUnit(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Values on the rig</h2>
        {edited && <span className="badge warn">Not applied</span>}
      </div>
      <div className="form-row">
        <label className="field">
          <span className="field-label">Encoder counts / rev</span>
          <input
            className={`input ${rev !== null ? "edited" : ""}`}
            type="number"
            step="any"
            disabled={busy}
            value={rev ?? calText(status?.countsPerRev)}
            onChange={(e) => setRev(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Load counts / unit</span>
          <input
            className={`input ${unit !== null ? "edited" : ""}`}
            type="number"
            step="any"
            disabled={busy}
            value={unit ?? calText(status?.countsPerUnit)}
            onChange={(e) => setUnit(e.target.value)}
          />
        </label>
      </div>
      {error && <div className="callout bad">{error}</div>}
      <div className="step-actions">
        <button
          className="btn"
          disabled={busy || !edited}
          onClick={() => void apply(Number(rev ?? status?.countsPerRev), Number(unit ?? status?.countsPerUnit))}
        >
          Apply
        </button>
        <button
          className="btn ghost"
          disabled={!edited}
          onClick={() => {
            setRev(null);
            setUnit(null);
            setError(null);
          }}
        >
          Revert
        </button>
        {savedDiffers && saved && (
          <button className="btn ghost" disabled={busy} onClick={() => void apply(saved.countsPerRev, saved.countsPerUnit)}>
            Restore {calText(saved.countsPerRev)} / {calText(saved.countsPerUnit)}
          </button>
        )}
      </div>
    </div>
  );
}

function I2cPanel() {
  const c = useController();
  const connected = useApp((s) => s.connection.state === "connected");
  const running = useApp((s) => s.run.running);
  const busy = !connected || running;
  const found = useApp((s) => s.i2c);
  const [scanning, setScanning] = useState(false);
  const hex = (a: number) => `0x${a.toString(16).padStart(2, "0")}`;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>I2C bus</h2>
        <button
          className="btn sm"
          disabled={busy || scanning}
          onClick={async () => {
            setScanning(true);
            await c.scanI2c();
            setScanning(false);
          }}
        >
          {scanning ? "Scanning…" : "Scan"}
        </button>
      </div>
      {found === null ? (
        <p className="muted small">Not scanned yet. Both INA219s should answer.</p>
      ) : (
        <div className="chips">
          {Object.entries(KNOWN_I2C).map(([addr, name]) => {
            const ok = found.includes(Number(addr));
            return (
              <span key={addr} className={`chip ${ok ? "ok" : "missing"}`}>
                {hex(Number(addr))} {name}
                {ok ? "" : ": missing"}
              </span>
            );
          })}
          {found
            .filter((a) => !(a in KNOWN_I2C))
            .map((a) => (
              <span key={a} className="chip">
                {hex(a)}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
