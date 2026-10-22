// Conveniences remembered between visits. The browser may forget them
// (private windows, cleared data), and everything works when it does --
// nothing here is the only copy of anything that matters: the calibration
// lives on the rig, and every sweep is downloaded as CSV.

const PREFIX = "motor-rig.";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: a convenience lost, nothing more */
  }
}

/** Hand the operator a file to keep. */
export function download(name: string, text: string, type = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
