import { useEffect, useState } from "react";
import { RigPanel } from "./components/RigPanel";
import { TopBar, type View } from "./components/TopBar";
import { useApp, useController } from "./state/hooks";
import { load, save } from "./state/storage";
import { CalibrateView } from "./views/CalibrateView";
import { ResultsView } from "./views/ResultsView";
import { SettingsView } from "./views/SettingsView";
import { TestView } from "./views/TestView";

const VIEWS: View[] = ["test", "results", "calibrate", "settings"];

export function App() {
  const c = useController();
  const banner = useApp((s) => s.banner);
  const [view, setViewState] = useState<View>(() => {
    const saved = load<View>("view", "test");
    return VIEWS.includes(saved) ? saved : "test";
  });
  const setView = (v: View) => {
    setViewState(v);
    save("view", v);
  };

  useEffect(() => {
    // Esc is E-STOP from anywhere, inputs included.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && c.connected) {
        e.preventDefault();
        void c.estop();
      }
    };
    // Leaving with the motor running or a sweep going: stop the rig first.
    const onUnload = (e: BeforeUnloadEvent) => {
      if (c.beforeUnload()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    // Plugging in a port this page already knows connects it.
    const onPlug = (e: Event) => void c.portPlugged(e.target as SerialPort);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeunload", onUnload);
    if ("serial" in navigator) navigator.serial.addEventListener("connect", onPlug);

    if (new URLSearchParams(location.search).has("demo")) void c.connectSimulated();
    else void c.autoConnect();

    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeunload", onUnload);
      if ("serial" in navigator) navigator.serial.removeEventListener("connect", onPlug);
    };
  }, [c]);

  return (
    <div className="shell">
      <TopBar view={view} onView={setView} />
      {banner && (
        <div className="banner" role="alert">
          <span>{banner}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => c.dismissBanner()}>
            ×
          </button>
        </div>
      )}
      <div className="body">
        <RigPanel />
        <main className="views" role="tabpanel" aria-labelledby={`tab-${view}`}>
          {view === "test" && <TestView onView={setView} />}
          {view === "results" && <ResultsView />}
          {view === "calibrate" && <CalibrateView />}
          {view === "settings" && <SettingsView />}
        </main>
      </div>
    </div>
  );
}
