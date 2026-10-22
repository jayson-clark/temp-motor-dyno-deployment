# Motor Rig app

Drive the motor test rig and characterize motors on it, from a web page.
It replaces the Motor Rig tab that ERC2 Link had before Link became a VS
Code extension.

The page talks to the rig's ERC2 controller over USB through the browser's
Web Serial API. There is nothing to install, but it only works in **Google
Chrome or Microsoft Edge** on a computer.

The build is a single self-contained file, `dist/index.html`, with all its
scripts and styles inlined. It needs no server and no network. It works
opened straight from disk, which matters because Chrome refuses separate
module scripts on a page opened from a file, or from any static host.

## Using it

The rig has two power sources. The ERC2's battery runs only the controller.
The test motor runs from a separate **bench power supply**, set to the
motor's rated voltage, with its current limit above the motor's stall
current. Set **Motor voltage** under **Settings** to match the supply.

1. Flash the rig's controller with the `motor-rig` firmware
   (`apps/motor-rig`), if it isn't already.
2. Open `dist/index.html` in Chrome or Edge.
3. Plug the rig in, turn the ERC2's battery on, switch on the bench supply,
   and click **Connect rig**. The first time, the browser asks which port to
   use. After that the rig connects on its own whenever it's plugged in and
   the page is open. Close any Serial Monitor or ERC2 Link first: only one
   program can use the port at a time.

Connecting takes about five seconds, because opening the port restarts the
board. If the ERC2's battery is off, the page says so and connects as soon as
it comes on.

**E-STOP** in the top bar, or **Esc** from anywhere on the page, cuts the
test motor, releases the brake, and cancels a sweep. Closing the page also
stops the rig.

The layout:

- **Rig panel**, on the left, always visible:
  - **Controls:** test motor on/off and the brake, with presets.
  - **Live readings:** speed and current with 30-second trends; torque in
    N·m, converted with the sweep's settings; motor supply, power,
    generator, encoder and the ERC2's battery.
  - **Sensor lights** for both INA219s and the load cell.
  - **Tare** and **Reset encoder**.
- **Test:** enter the motor's ID and **Run sweep**. You get:
  - the headline figures: no-load speed, stall torque, peak power, no-load
    current, peak efficiency and fit R²
  - the performance curves (speed, current, shaft power and efficiency
    against torque) with fitted lines, and the raw samples on demand
  - every measured point

  The curve and raw CSV files download when the sweep finishes, named with
  the motor ID.
- **Results:** every sweep of the session, one row per motor. Mark a
  reference motor and the rest are scored and graded against it, using the
  scheme suggested in the Operator Guide (section 8.3), and only between
  motors run at the same voltage. **Summary CSV** exports the table, with the
  calibration and supply voltage each motor was measured with.
- **Calibrate:**
  - **Load cell** and **encoder** helpers that do the arithmetic for you.
  - **Values on the rig:** the two calibration constants, editable directly.
  - **I2C scan.**
- **Settings:** the sweep settings. Use the same ones for every motor in a
  batch.

Sweep settings and the session's results are remembered in the browser.

To try the page without a rig, click **Use a simulated rig**, or open
`index.html?demo`. The top bar says *Simulated* the whole time. The simulated
motor is fitted to a real 6 V gearmotor measured on the rig.

### Calibration

The calibration lives on the rig. From firmware `motorrig-1.3` it is kept in
EEPROM, so it survives restarts (including the one every connection causes),
and every computer sees the same values. Older firmware kept it in RAM and
lost it on every restart; if the rig comes up on the firmware's defaults,
the page puts back the calibration it last applied. The Test view warns
before a run while the rig is on its defaults.

**Load cell**, from a hung weight:

1. With the motor off and the lever arm resting on the load cell as it does
   in a test, click **Tare**.
2. Hang a known weight from the arm, on the side that presses it into the
   cell. Enter its mass, and its horizontal distance from the centre of the
   generator shaft (38 mm by default).
3. Click **Measure**, then **Apply calibration**. The live reading then shows
   beside what the weight should read.

The page calibrates in torque, so where the load cell sits on the arm
doesn't matter. If the sweep was set to a force unit, it switches the sweep to
kg·cm to match.

**Encoder:** click **Reset encoder**, turn the generator output shaft a whole
number of times by hand (up to about 40), enter how many, and click
**Apply**.

### Motor voltage

Voltage isn't part of the curve maths, since torque, speed and current are
all measured. What it changes is the motor itself: speed and torque scale
with voltage. So the sweep checks the supply:

- **Before the motor starts,** with the motor off so the reading is the
  supply's own, it must be within 10% of **Motor voltage**. Otherwise the
  sweep stops without running anything. This guards against, for example, a
  6 V motor on a supply left at 12 V.
- **During the sweep,** a sag of more than 15% under load means the supply is
  current-limiting. The sweep aborts rather than give a curve measured at the
  wrong voltage. It judges the median of the last quarter second, never one
  reading: the INA219 occasionally returns a single reading 20–25% low (the
  brake's switching gets into it), and that must not stop a run.

Set **Motor voltage** to 0 to turn both checks off.

## Developing

```bash
npm install
npm run dev          # the app at http://localhost:5173 (use ?demo for the simulator)
npm test             # the logic, in Node, against the simulated rig
npm run build        # typecheck, then dist/index.html
npm run real-rig     # check against a real rig (see below)
```

It's React and TypeScript, built with Vite, with Vitest for the tests.

```
src/lib/        the logic, with no React in it
  protocol.ts     the rig's serial frames: 0xAB 0xCD cmd len payload, no CRC
  transport.ts    the port interface, and Web Serial's implementation of it
  rig.ts          connecting through the board's restart, its commands, the 10 Hz poll
  simulator.ts    a simulated rig behind the same transport interface
  stats.ts        median, MAD rejection, trimmed mean, linear fit
  sweep.ts        the characterization sweep, CSV export, grading
  calibration.ts  load-cell span from a hung weight; encoder counts from turns
src/state/      the controller: everything the app does, as a store the UI reads
src/components/ the top bar, the rig panel, SVG charts
src/views/      Test, Results, Calibrate, Settings
test/           Vitest suites
scripts/        the real-rig check
```

The controller (`src/state/controller.ts`) owns the connection, the live
readings, sweeps, results and persistence. Components read slices of its
state through `useApp()` and call its methods. Nothing in `src/lib` or
`src/state` touches the DOM, so all of it runs under the tests.

The protocol comes from `apps/motor-rig/src/main.cpp`. A board counts as a
rig when its `VERSION` reply starts with `motorrig`. Status is a 54-byte
frame, or 46 bytes from `motorrig-1.0`, which did not yet report its
calibration.

### Connecting

The rig firmware never sets its own baud. It runs at whatever the FEH
library opened the port at: 500000 from library v2.2, and 115200 before
that. The app tries 500000 first, and moves to 115200 if the board's output
arrives garbled.

Opening the port restarts the Mega, and the order of what happens next
matters:

1. **The bootloader runs first.** It waits for an upload for as long as
   bytes keep arriving, so a host that starts asking straight away keeps the
   board in its bootloader indefinitely. The app sends nothing while the
   board starts.
2. **Then the FEH library starts.** It prints a line per stage and takes
   about five seconds. If the battery is off, it stops after its first line
   to wait for power, and the app says so.
3. **Then the rig's code runs.** From `motorrig-1.2` on, the rig sends its
   `VERSION` unprompted at this point, and the app connects straight away.
   Older rigs are asked once the library has printed "initialized
   successfully".

If the board is running an ordinary ERC2 program, its link agent answers the
rig's frames (which have no CRC) with errors, and the app says what's on the
board instead of timing out.

### The sweep

`sweep.ts` is a port of ERC2 Link's `rig_test.py`. On 500 randomized inputs,
its statistics, fits and brake schedules matched the Python's exactly. The
filtering (MAD rejection, then a trimmed mean), fits and CSV columns are the
same, so curves measured here compare with ones measured under Link. Three
settings differ:

- **Motor voltage** is new.
- **Load cell unit** defaults to kg·cm, the only unit the firmware's default
  calibration (390,000 counts per unit) makes sense in.
- **Lever arm** defaults to the rig's 38 mm.

## Tests

`npm test` runs the protocol codec, the sweep maths, grading and
calibration. It also runs the rig client and complete sweeps against the
simulated rig, which restarts the way the real board does, bootloader
included. Those sweeps cover cancelling, a lost connection, a low ERC2
battery, a mis-set or current-limiting bench supply, and the wrong firmware.
No browser or hardware is needed.

`npm run real-rig -- [port]` checks a real rig from the command line. It
runs the app's own connection and protocol code, with a pyserial bridge
standing in for Web Serial (PlatformIO's Python has pyserial). It connects,
reads status, scans the I2C bus, and counts the status poll's frames. It
never starts the motor or moves the brake. Close the app first, since the
port can only have one user.

- `--check-calibration` also proves the calibration survives a restart. It
  writes a slightly changed value, reconnects (which restarts the board),
  checks the value came back, and then restores the original.
- `--check-tare` tares, and checks the tare finishes and zeroes the load
  cell.
