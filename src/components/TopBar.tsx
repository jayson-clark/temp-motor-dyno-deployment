import { onDefaultCalibration } from "../state/controller";
import { useApp, useController } from "../state/hooks";

export type View = "test" | "results" | "calibrate" | "settings";

const VIEWS: { id: View; label: string }[] = [
  { id: "test", label: "Test" },
  { id: "results", label: "Results" },
  { id: "calibrate", label: "Calibrate" },
  { id: "settings", label: "Settings" },
];

const PHASE_TEXT = {
  restarting: "Restarting the board…",
  starting: "Board starting up…",
  "waiting-power": "Waiting for power: switch the ERC2's battery on",
  identifying: "Checking for the motor-rig firmware…",
} as const;

export function TopBar({ view, onView }: { view: View; onView: (v: View) => void }) {
  const c = useController();
  const connection = useApp((s) => s.connection);
  const resultsCount = useApp((s) => s.results.length);
  const status = useApp((s) => s.status);
  const uncalibrated = onDefaultCalibration(status);
  const connected = connection.state === "connected";

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const i = VIEWS.findIndex((v) => v.id === view);
    const next = VIEWS[(i + step + VIEWS.length) % VIEWS.length].id;
    onView(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  let text = "Not connected";
  if (connection.state === "connecting") {
    text = connection.phase ? PHASE_TEXT[connection.phase] : "Connecting…";
    if (connection.baud && connection.baud !== 500000 && connection.phase === "restarting") text = `Trying ${connection.baud} baud…`;
  } else if (connected) {
    text = `${connection.version} · ${connection.label}${connection.baud ? ` · ${connection.baud / 1000}k` : ""}`;
  }

  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="13" />
          <path d="M16 16 L24 9" />
          <circle cx="16" cy="16" r="3" className="hub" />
        </svg>
        <span>Motor Rig</span>
      </div>

      <nav className="nav" role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            id={`tab-${v.id}`}
            role="tab"
            aria-selected={view === v.id}
            tabIndex={view === v.id ? 0 : -1}
            onClick={() => onView(v.id)}
          >
            {v.label}
            {v.id === "results" && resultsCount > 0 && <span className="count">{resultsCount}</span>}
            {v.id === "calibrate" && uncalibrated && <span className="dot-alert" title="The rig is on default calibration" />}
          </button>
        ))}
      </nav>

      <div className="conn" role="status">
        <span className={`dot ${connected ? "on" : connection.state === "connecting" ? "busy" : ""}`} />
        <span className={`conn-text ${connection.phase === "waiting-power" ? "attention" : ""}`}>{text}</span>
        {connection.simulated && connected && (
          <span className="badge warn" title="The numbers are made up. Connect a real rig to test motors.">
            Simulated
          </span>
        )}
        {connected ? (
          <button className="btn ghost sm" onClick={() => void c.disconnect()}>
            Disconnect
          </button>
        ) : (
          <button className="btn sm" disabled={connection.state === "connecting"} onClick={() => void c.chooseAndConnect()}>
            Connect
          </button>
        )}
      </div>

      <button
        className="estop"
        disabled={!connected}
        title="Cut the test motor, release the brake, and cancel a sweep (Esc)"
        onClick={() => void c.estop()}
      >
        E-STOP <kbd>Esc</kbd>
      </button>
    </header>
  );
}
