// Check the app's rig client against a real rig, from the command line.
//
// Web Serial only exists in a browser, so this swaps in a transport that runs
// the port through Python's pyserial (PlatformIO's Python has it). Everything
// above the transport -- the start-up handling, identification, the
// protocol -- is the app's own code.
//
//     npm run real-rig -- [port]                       connect, read status, scan I2C
//     npm run real-rig -- --check-calibration [port]   also: change the calibration,
//         reconnect (which restarts the board), check the rig kept it, then put
//         the original back
//     npm run real-rig -- --check-tare [port]          also: tare, and check it
//         finishes and zeroes the load cell
//
// It never starts the motor or moves the brake.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RigClient } from "../src/lib/rig";
import { median } from "../src/lib/stats";
import type { Transport } from "../src/lib/transport";

const BRIDGE = `
import sys, threading, serial
s = serial.Serial(sys.argv[1], int(sys.argv[2]), timeout=0.02)
def pump_in():
    while True:
        data = sys.stdin.buffer.read1(256)
        if not data:
            break
        s.write(data)
threading.Thread(target=pump_in, daemon=True).start()
out = sys.stdout.buffer
while True:
    data = s.read(256)
    if data:
        out.write(data); out.flush()
`;

function python(): string {
  const pio = join(homedir(), ".platformio", "penv", "bin", "python");
  return existsSync(pio) ? pio : "python3";
}

function findPort(): string | undefined {
  const out = execFileSync(python(), ["-c", "import serial.tools.list_ports as l\nfor p in l.comports():\n  print(p.device, p.vid or 0)"]).toString();
  return out
    .split("\n")
    .map((l) => l.split(" "))
    .find(([dev, vid]) => dev && Number(vid) > 0)?.[0];
}

class PySerialTransport implements Transport {
  readonly label: string;
  baud?: number;
  onData: (bytes: Uint8Array) => void = () => {};
  onClose: (reason: string | null) => void = () => {};
  private proc: ChildProcess | null = null;
  private closing = false;

  constructor(private readonly port: string) {
    this.label = port;
  }

  async open(baud: number) {
    this.baud = baud;
    this.closing = false;
    const proc = spawn(python(), ["-u", "-c", BRIDGE, this.port, String(baud)], { stdio: ["pipe", "pipe", "inherit"] });
    proc.stdout!.on("data", (b: Buffer) => this.onData(new Uint8Array(b)));
    proc.on("exit", (code) => {
      if (this.proc === proc && !this.closing) this.onClose(`bridge exited (${code})`);
    });
    this.proc = proc;
  }

  async write(bytes: Uint8Array) {
    this.proc?.stdin!.write(Buffer.from(bytes));
  }

  async close() {
    this.closing = true;
    const proc = this.proc;
    this.proc = null;
    if (proc) await new Promise((r) => (proc.on("exit", r), proc.kill()));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listen<T>(rig: RigClient, ms: number, pick: (s: NonNullable<RigClient["status"]>) => T): Promise<T[]> {
  return new Promise((resolve) => {
    const seen: T[] = [];
    const off = rig.on("status", (s) => seen.push(pick(s)));
    setTimeout(() => (off(), resolve(seen)), ms);
  });
}

async function checkTare(port: string, at: () => string) {
  const rig = new RigClient(new PySerialTransport(port));
  await rig.connect();
  const before = await listen(rig, 1500, (s) => s.loadRaw);
  let sawTaring = false;
  let doneAfter: number | null = null;
  const t0 = Date.now();
  const off = rig.on("status", (s) => {
    if (s.taring) sawTaring = true;
    else if (sawTaring && doneAfter === null) doneAfter = Date.now() - t0;
  });
  await rig.tare();
  await sleep(4000);
  off();
  const after = await listen(rig, 1500, (s) => s.loadRaw);
  const zero = Math.round(median(after));
  const jitter = Math.max(...after) - Math.min(...after);
  console.log(
    `${at()}  tare: ${Math.round(median(before))} counts before; ` +
      `${sawTaring ? `finished after ${doneAfter} ms` : "never seen taring"}; ${zero} counts after (jitter ${jitter})`,
  );
  await rig.close();
  if (!sawTaring || doneAfter === null || Math.abs(zero) > Math.max(2000, jitter)) process.exitCode = 1;
}

async function checkCalibration(port: string, at: () => string) {
  const connect = async () => {
    const rig = new RigClient(new PySerialTransport(port));
    await rig.connect();
    return rig;
  };
  let rig = await connect();
  const original = { ...rig.status! };
  const test = { cpr: original.countsPerRev! + 1, cpu: original.countsPerUnit! * 1.001 };
  console.log(`${at()}  calibration now ${original.countsPerRev} / ${original.countsPerUnit}; setting ${test.cpr} / ${test.cpu.toFixed(1)}`);
  await rig.setCalibration(test.cpr, test.cpu);
  await sleep(300);
  await rig.close();
  rig = await connect(); // a fresh connection restarts the board
  const after = rig.status!;
  const kept = Math.abs(after.countsPerRev! - test.cpr) < 1e-3 && Math.abs(after.countsPerUnit! / test.cpu - 1) < 1e-6;
  console.log(`${at()}  after the restart: ${after.countsPerRev} / ${after.countsPerUnit!.toFixed(1)}  ${kept ? "KEPT" : "LOST"}`);
  await rig.setCalibration(original.countsPerRev!, original.countsPerUnit!);
  await sleep(300);
  console.log(`${at()}  restored ${rig.status!.countsPerRev} / ${rig.status!.countsPerUnit}`);
  await rig.close();
  if (!kept) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const port = args.find((a) => !a.startsWith("--")) ?? findPort();
  if (!port) throw new Error("No USB serial port found");
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(2)} s`;
  const rig = new RigClient(new PySerialTransport(port));
  console.log(`${at()}  opening ${port}`);
  const version = await rig.connect({ onProgress: (p, baud) => console.log(`${at()}  ${p} (${baud} baud)`) });
  console.log(`${at()}  connected: ${version} at ${rig.transport.baud} baud`);
  const s = (await rig.requestStatus())!;
  console.log(
    `${at()}  status: ERC2 battery ${s.batteryV.toFixed(2)} V, motor supply ${s.inaTestOk ? s.test.voltageV.toFixed(2) + " V" : "?"}, ` +
      `motor ${s.motorOn ? "on" : "off"}, brake ${s.brake}%, INA219 test ${s.inaTestOk ? "ok" : "MISSING"}, gen ${s.inaGenOk ? "ok" : "MISSING"}, ` +
      `load ${s.loadValid ? s.load.toFixed(4) : "no data"}, rpm ${s.rpm.toFixed(1)}, cal ${s.countsPerRev}/${s.countsPerUnit}`,
  );
  const i2c = await rig.scanI2c();
  console.log(`${at()}  I2C: ${i2c ? i2c.map((a) => "0x" + a.toString(16)).join(" ") || "nothing" : "no reply"}`);
  const frames = (await listen(rig, 2000, () => 1)).length;
  console.log(`${at()}  ${frames} status frames in 2 s from the 10 Hz poll`);
  await rig.close();
  if (args.includes("--check-calibration")) await checkCalibration(port, at);
  if (args.includes("--check-tare")) await checkTare(port, at);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
