// The motor-rig firmware's serial protocol (apps/motor-rig/src/main.cpp).
//
// The rig still speaks the original ERC2 frame, without the CRC the main
// firmware has since grown:
//
//     0xAB 0xCD  cmd  len  payload[len]
//
// every multi-byte value little-endian. It answers VERSION with a string
// starting "motorrig", which is how a board is told apart from an ERC2
// running anything else.
//
// The baud is whatever the FEH library opened the port at, since the rig
// firmware never sets its own: 500000 from library v2.2, 115200 before.

export const SYNC1 = 0xab;
export const SYNC2 = 0xcd;
/** Tried in this order: the current library's, then the old one's. */
export const BAUDS = [500000, 115200] as const;

export const CMD = {
  PING: 0x01,
  VERSION: 0x02,
  RIG_STATUS: 0x50,
  RIG_MOTOR: 0x51, // [1] 0/1
  RIG_BRAKE: 0x52, // [1] duty 0..100
  RIG_TARE: 0x53,
  RIG_RESET_ENC: 0x54,
  RIG_ESTOP: 0x55,
  RIG_I2C_SCAN: 0x56,
  RIG_SET_CAL: 0x57, // [4] counts/rev float, [4] counts/unit float
} as const;

export const RSP = {
  PONG: 0x82,
  VERSION: 0x83,
  RIG_STATUS: 0xc0,
  RIG_I2C: 0xc1,
} as const;

// What an ERC2 running an ordinary program sends back: its link agent
// speaks the newer, CRC-checked frame and answers a frame without one with
// an error. Seeing any of these means "not the rig firmware".
export const ERC2_AGENT_REPLIES = new Set([0x80, 0x81, 0x98]);

// The firmware's receive buffer; it drops anything longer and resyncs.
export const MAX_COMMAND_PAYLOAD = 50;

export interface Frame {
  cmd: number;
  payload: Uint8Array;
}

/** One frame, of any length the length byte can carry. */
export function frame(cmd: number, payload?: ArrayLike<number>): Uint8Array {
  const body = payload ? Uint8Array.from(payload) : new Uint8Array(0);
  if (body.length > 255) throw new RangeError("payload too long for a frame");
  const out = new Uint8Array(4 + body.length);
  out.set([SYNC1, SYNC2, cmd, body.length]);
  out.set(body, 4);
  return out;
}

/** A command for the rig, which drops anything over its 50-byte buffer. */
export function encode(cmd: number, payload?: ArrayLike<number>): Uint8Array {
  if (payload && payload.length > MAX_COMMAND_PAYLOAD) throw new RangeError("payload too long for the rig");
  return frame(cmd, payload);
}

/**
 * Turns the byte stream back into frames: the same state machine the
 * firmware uses, so a stray byte or a half frame from before the board
 * reset costs one frame and resyncs on the next 0xAB 0xCD.
 */
export class FrameDecoder {
  private state = 0;
  private cmd = 0;
  private len = 0;
  private buf = new Uint8Array(0);
  private idx = 0;

  /** Feed bytes; returns the frames they completed. */
  push(bytes: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    for (const c of bytes) {
      switch (this.state) {
        case 0:
          if (c === SYNC1) this.state = 1;
          break;
        case 1:
          this.state = c === SYNC2 ? 2 : c === SYNC1 ? 1 : 0;
          break;
        case 2:
          this.cmd = c;
          this.state = 3;
          break;
        case 3:
          this.len = c;
          if (c === 0) {
            frames.push({ cmd: this.cmd, payload: new Uint8Array(0) });
            this.state = 0;
          } else {
            this.buf = new Uint8Array(c);
            this.idx = 0;
            this.state = 4;
          }
          break;
        case 4:
          this.buf[this.idx++] = c;
          if (this.idx >= this.len) {
            frames.push({ cmd: this.cmd, payload: this.buf });
            this.state = 0;
          }
          break;
      }
    }
    return frames;
  }
}

export const STATUS_MIN_BYTES = 46; // motorrig-1.0, before calibration was echoed
export const STATUS_BYTES = 54;

export interface Power {
  currentMa: number;
  voltageV: number;
  powerMw: number;
}

export interface RigStatus {
  motorOn: boolean;
  inaTestOk: boolean;
  inaGenOk: boolean;
  loadValid: boolean;
  taring: boolean;
  brake: number;
  test: Power;
  gen: Power;
  /** Calibrated load, in whatever unit the rig's span was worked out in. */
  load: number;
  /** HX711 counts less the tare. */
  loadRaw: number;
  rpm: number;
  counts: number;
  /** The ERC2's own battery, which only runs the controller. */
  batteryV: number;
  /** Null from motorrig-1.0, which did not report its calibration. */
  countsPerRev: number | null;
  countsPerUnit: number | null;
}

/**
 * The rig's status frame. motorrig-1.0 sends 46 bytes; 1.1 appends the two
 * calibration constants it is actually running, which are null here for
 * the older firmware rather than a made-up default.
 */
export function parseStatus(payload: Uint8Array): RigStatus | null {
  if (payload.length < STATUS_MIN_BYTES) return null;
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const f = (o: number) => v.getFloat32(o, true);
  const flags = payload[0];
  const full = payload.length >= STATUS_BYTES;
  return {
    motorOn: !!(flags & 0x01),
    inaTestOk: !!(flags & 0x02),
    inaGenOk: !!(flags & 0x04),
    loadValid: !!(flags & 0x08),
    taring: !!(flags & 0x10),
    brake: payload[1],
    test: { currentMa: f(2), voltageV: f(6), powerMw: f(10) },
    gen: { currentMa: f(14), voltageV: f(18), powerMw: f(22) },
    load: f(26),
    loadRaw: v.getInt32(30, true),
    rpm: f(34),
    counts: v.getInt32(38, true),
    batteryV: f(42),
    countsPerRev: full ? f(46) : null,
    countsPerUnit: full ? f(50) : null,
  };
}

/** The I2C scan reply: a count, then that many 7-bit addresses. */
export function parseI2c(payload: Uint8Array): number[] {
  const n = Math.min(payload[0] || 0, payload.length - 1);
  return Array.from(payload.subarray(1, 1 + n));
}

export function parseVersion(payload: Uint8Array): string {
  return new TextDecoder().decode(payload);
}

export function isRigVersion(text: string): boolean {
  // The firmware's note: keep the "motorrig" prefix if the number moves.
  return /^motorrig/i.test(text);
}

export function calibrationPayload(countsPerRev: number, countsPerUnit: number): Uint8Array {
  const out = new Uint8Array(8);
  const v = new DataView(out.buffer);
  v.setFloat32(0, countsPerRev, true);
  v.setFloat32(4, countsPerUnit, true);
  return out;
}

/** The firmware's own defaults, for the simulator and for spotting an uncalibrated rig. */
export const DEFAULT_CALIBRATION = { countsPerRev: 1398.0, countsPerUnit: 390000.0 } as const;

/** The rig's two INA219s, by the address each is strapped to. */
export const KNOWN_I2C: Record<number, string> = { 0x40: "Test motor INA219", 0x41: "Generator INA219" };
