// The port a rig is reached through. A transport is anything with open,
// write, close, and two callbacks; the browser's Web Serial port is one, the
// simulator another, and the command-line check (scripts/real-rig.ts) a
// third. Everything above it runs the same against any of them.

export interface Transport {
  readonly label: string;
  readonly simulated?: boolean;
  /** The baud it was last opened at. */
  baud?: number;
  onData: (bytes: Uint8Array) => void;
  onClose: (reason: string | null) => void;
  open(baud: number): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

// USB vendor ids of the serial chips a Mega 2560 turns up with: Arduino's
// own (two ids over the years), the CH340 on most clones, FTDI and CP210x.
// The browser's port picker shows only these, so nobody is choosing between
// Bluetooth modems and docking stations.
const MAKERS: Record<number, string> = {
  0x2341: "Arduino",
  0x2a03: "Arduino",
  0x1a86: "CH340",
  0x0403: "FTDI",
  0x10c4: "CP210x",
};
const USB_FILTERS = Object.keys(MAKERS).map((id) => ({ usbVendorId: Number(id) }));

export function webSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export function describePort(port: SerialPort): string {
  const info = port.getInfo ? port.getInfo() : {};
  if (!info.usbVendorId) return "Serial port";
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  return `${MAKERS[info.usbVendorId] ?? "USB"} ${hex(info.usbVendorId)}:${hex(info.usbProductId ?? 0)}`;
}

export class WebSerialTransport implements Transport {
  readonly label: string;
  baud?: number;
  onData: (bytes: Uint8Array) => void = () => {};
  onClose: (reason: string | null) => void = () => {};
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closing = false;

  constructor(readonly port: SerialPort) {
    this.label = describePort(port);
  }

  async open(baud: number): Promise<void> {
    this.baud = baud;
    await this.port.open({ baudRate: baud, bufferSize: 4096 });
    this.writer = this.port.writable!.getWriter();
    this.closing = false;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    let reason: string | null = null;
    try {
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value?.length) this.onData(value);
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (err) {
      // Unplugging the cable lands here, as a NetworkError.
      reason = err instanceof Error ? err.message : String(err);
    }
    if (!this.closing) this.onClose(reason ?? "The port closed");
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("Port is not open");
    await this.writer.write(bytes);
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* already gone */
    }
    try {
      this.writer?.releaseLock();
      this.writer = null;
    } catch {
      /* already gone */
    }
    try {
      await this.port.close();
    } catch {
      /* already closed */
    }
  }
}

/** Ports this page has been allowed to use before, without asking again. */
export async function grantedPorts(): Promise<SerialPort[]> {
  return webSerialSupported() ? navigator.serial.getPorts() : [];
}

/** Ask which port to use; resolves null if the picker is cancelled. */
export async function choosePort(allPorts = false): Promise<SerialPort | null> {
  try {
    return await navigator.serial.requestPort(allPorts ? {} : { filters: USB_FILTERS });
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return null; // cancelled
    throw err;
  }
}
