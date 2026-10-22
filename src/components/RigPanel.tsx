import { useMemo } from "react";
import { torqueNm } from "../lib/sweep";
import { useApp, useController } from "../state/hooks";
import { Sparkline } from "./Chart";
import { fixed } from "./format";

const PRESETS = [0, 25, 50, 75, 100];

/** The rig, always at hand: connect, drive it by hand, and watch it. */
export function RigPanel() {
  const connection = useApp((s) => s.connection);
  return (
    <aside className="rig" aria-label="Rig">
      {connection.state === "connected" ? <LivePanel /> : <ConnectPanel />}
    </aside>
  );
}

function ConnectPanel() {
  const c = useController();
  const supported = useApp((s) => s.supported);
  const connecting = useApp((s) => s.connection.state === "connecting");
  return (
    <section className="rig-connect">
      <h2 className="eyebrow">Rig</h2>
      <p className="lead">{connecting ? "Connecting…" : "Not connected"}</p>
      <p className="muted small">
        Plug the ERC2 in over USB with its battery on, and switch on the test motor's bench supply. The board must run
        the <code>motor-rig</code> firmware.
      </p>
      {!supported && (
        <div className="callout warn">
          This browser can't use USB serial devices. Open the page in Google Chrome or Microsoft Edge on a computer.
        </div>
      )}
      {supported && (
        <button className="btn primary wide" disabled={connecting} onClick={() => void c.chooseAndConnect()}>
          {connecting ? <span className="spinner" /> : null}
          {connecting ? "Connecting" : "Connect rig"}
        </button>
      )}
      <div className="link-row">
        {supported && (
          <button className="link" disabled={connecting} onClick={() => void c.chooseAndConnect(true)}>
            Rig not listed?
          </button>
        )}
        <button className="link" disabled={connecting} onClick={() => void c.connectSimulated()}>
          Use a simulated rig
        </button>
      </div>
      <p className="muted small">
        Connecting takes about five seconds: the board restarts when the port opens. Once allowed, the rig connects by
        itself whenever it's plugged in and this page is open.
      </p>
    </section>
  );
}

function LivePanel() {
  const c = useController();
  const s = useApp((st) => st.status);
  // The numbers are each the median of the last second (see the controller):
  // raw readings jitter in the last digit or two at 10 Hz and are hard to read.
  const m = useApp((st) => st.smoothed);
  const brake = useApp((st) => st.brake);
  const live = useApp((st) => st.live);
  const params = useApp((st) => st.params);
  const sweeping = useApp((st) => st.run.running);
  const rpms = useMemo(() => live.map(([, rpm]) => rpm), [live]);
  const amps = useMemo(() => live.map(([, , a]) => a), [live]);

  const motorOn = !!s?.motorOn;
  const torque = m?.load != null ? torqueNm(m.load, params) : null;
  const sensor = (ok: boolean | undefined, warn = false) => (ok === undefined ? "" : warn ? "warn" : ok ? "ok" : "bad");

  return (
    <div className="rig-live">
      <section className="rig-section">
        <div className="row-head">
          <h2 className="eyebrow">Test motor</h2>
          <span className={`badge ${motorOn ? "ok" : ""}`}>{motorOn ? "Running" : "Off"}</span>
        </div>
        <button
          className={`btn wide ${motorOn ? "running" : "primary"}`}
          disabled={sweeping}
          onClick={() => void c.setMotor(!motorOn)}
        >
          {motorOn ? "Stop motor" : "Start motor"}
        </button>
      </section>

      <section className="rig-section">
        <div className="row-head">
          <h2 className="eyebrow">Brake</h2>
          <span className="value-lg">{brake}%</span>
        </div>
        <input
          type="range"
          className="slider"
          min={0}
          max={100}
          step={1}
          value={brake}
          disabled={sweeping}
          aria-label="Brake duty"
          onChange={(e) => c.pushBrake(Number(e.target.value))}
        />
        <div className="segmented" role="group" aria-label="Brake presets">
          <button disabled={sweeping} aria-label="Brake down 5%" onClick={() => c.pushBrake(brake - 5)}>
            −5
          </button>
          {PRESETS.map((p) => (
            <button key={p} disabled={sweeping} className={brake === p ? "active" : ""} onClick={() => c.pushBrake(p)}>
              {p}
            </button>
          ))}
          <button disabled={sweeping} aria-label="Brake up 5%" onClick={() => c.pushBrake(brake + 5)}>
            +5
          </button>
        </div>
        {sweeping && <p className="lock-note">A sweep is driving the rig. E-STOP still works.</p>}
      </section>

      <section className="rig-section">
        <h2 className="eyebrow">Readings</h2>
        <div className="metric">
          <span className="m-label">Speed</span>
          <span className="m-value">
            {fixed(m?.rpm, 1)}
            <span className="m-unit">rpm</span>
          </span>
          <Sparkline values={rpms} n={1} />
        </div>
        <div className="metric">
          <span className="m-label">Motor current</span>
          <span className="m-value">
            {fixed(m?.currentA, 3)}
            <span className="m-unit">A</span>
          </span>
          <Sparkline values={amps} n={2} />
        </div>
        <dl className="readout">
          <dt>Torque</dt>
          <dd title={m?.load != null ? `Load cell: ${fixed(m.load, 4)} ${params.load_unit}` : undefined}>
            {fixed(torque, 4)}
            <span className="m-unit">N·m</span>
          </dd>
          <dt>Motor supply</dt>
          <dd>
            {fixed(m?.supplyV, 2)}
            <span className="m-unit">V</span>
          </dd>
          <dt>Motor power</dt>
          <dd>
            {fixed(m?.powerW, 2)}
            <span className="m-unit">W</span>
          </dd>
          <dt>Generator</dt>
          <dd>
            {fixed(m?.genV, 2)}
            <span className="m-unit">V</span> {fixed(m?.genA, 3)}
            <span className="m-unit">A</span>
          </dd>
          <dt>Encoder</dt>
          <dd>
            {s ? s.counts.toLocaleString() : "—"}
            <span className="m-unit">counts</span>
          </dd>
          <dt>ERC2 battery</dt>
          <dd>
            {fixed(m?.batteryV, 2)}
            <span className="m-unit">V</span>
          </dd>
        </dl>
        <div className="sensors">
          <span className={`sensor ${sensor(s?.inaTestOk)}`} title="Test-motor INA219, I2C 0x40">
            Motor INA
          </span>
          <span className={`sensor ${sensor(s?.inaGenOk)}`} title="Generator INA219, I2C 0x41">
            Gen INA
          </span>
          <span className={`sensor ${sensor(s?.loadValid, s?.taring)}`} title="HX711 load cell">
            {s?.taring ? "Taring…" : "Load cell"}
          </span>
        </div>
      </section>

      <section className="rig-section">
        <div className="btn-pair">
          <button className="btn" disabled={sweeping || s?.taring} onClick={() => void c.tare()}>
            {s?.taring ? "Taring…" : "Tare"}
          </button>
          <button className="btn" disabled={sweeping} onClick={() => void c.resetEncoder()}>
            Reset encoder
          </button>
        </div>
        <p className="muted small">Tare with the motor off and nothing pressing on the load cell.</p>
      </section>
    </div>
  );
}
