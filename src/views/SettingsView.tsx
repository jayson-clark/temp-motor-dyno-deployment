import { useEffect, useState, type ReactNode } from "react";
import { LOAD_UNITS, type SweepParams } from "../lib/sweep";
import { useApp, useController } from "../state/hooks";

type NumKey = { [K in keyof SweepParams]: SweepParams[K] extends number ? K : never }[keyof SweepParams];
type BoolKey = { [K in keyof SweepParams]: SweepParams[K] extends boolean ? K : never }[keyof SweepParams];

/**
 * A number setting, committed when the field is left: typing "1" on the way
 * to "12" shouldn't be clamped and saved as 1 in the meantime.
 */
function NumberField({ name, label, unit, min, max, step }: { name: NumKey; label: string; unit?: string; min?: number; max?: number; step: number }) {
  const c = useController();
  const value = useApp((s) => s.params[name]);
  const locked = useApp((s) => s.run.running);
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n)) c.setParams({ [name]: n });
    else setText(String(value));
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className={unit ? "input-unit" : undefined}>
        <input
          className="input"
          type="number"
          min={min}
          max={max}
          step={step}
          disabled={locked}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        {unit && <span>{unit}</span>}
      </span>
    </label>
  );
}

function Check({ name, children }: { name: BoolKey; children: ReactNode }) {
  const c = useController();
  const value = useApp((s) => s.params[name]);
  const locked = useApp((s) => s.run.running);
  return (
    <label className="check">
      <input type="checkbox" checked={value} disabled={locked} onChange={(e) => c.setParams({ [name]: e.target.checked })} /> {children}
    </label>
  );
}

/**
 * One row of the settings: what the group is and why, on the left, and its
 * fields on the right, on the same columns as every other row's.
 */
function Group({ title, help, children }: { title: string; help: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="setting-row">
      <div className="setting-meta">
        <legend>{title}</legend>
        <p className="help">{help}</p>
      </div>
      <div className="setting-fields">{children}</div>
    </fieldset>
  );
}

export function SettingsView() {
  const c = useController();
  const unit = useApp((s) => s.params.load_unit);
  const locked = useApp((s) => s.run.running);

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Sweep settings</h1>
          <p className="muted">Use the same settings for every motor in a batch, or the results won't compare. Remembered in this browser.</p>
        </div>
        <button className="btn" disabled={locked} onClick={() => c.resetParams()}>
          Restore defaults
        </button>
      </div>

      <form className="panel settings" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Group
          title="Motor supply"
          help="What the bench supply is set to. Before starting the motor the sweep checks the supply is within 10%, and it stops if the supply stays more than 15% low under load. 0 turns both checks off."
        >
          <div className="fields">
            <NumberField name="motor_v" label="Motor voltage" unit="V" min={0} max={48} step={0.1} />
          </div>
        </Group>

        <Group title="Brake schedule" help="The brake duties the sweep steps through. Sweeping back down as well shows hysteresis, and doubles the time.">
          <div className="fields">
            <NumberField name="brake_start" label="Start" unit="%" min={0} max={100} step={1} />
            <NumberField name="brake_end" label="End" unit="%" min={0} max={100} step={1} />
            <NumberField name="brake_step" label="Step" unit="%" min={1} max={100} step={1} />
          </div>
          <Check name="bidirectional">Sweep back down too</Check>
        </Group>

        <Group title="Timing" help="The motor spins up unloaded first. Each brake step then settles (discarded) and dwells (measured) at the sample rate.">
          <div className="fields">
            <NumberField name="warmup_s" label="Warm-up" unit="s" min={0} max={30} step={0.1} />
            <NumberField name="settle_s" label="Settle" unit="s" min={0} max={30} step={0.1} />
            <NumberField name="dwell_s" label="Dwell" unit="s" min={0.2} max={60} step={0.1} />
            <NumberField name="sample_hz" label="Sample rate" unit="Hz" min={1} max={100} step={1} />
          </div>
        </Group>

        <Group
          title="Torque"
          help="The unit the load cell is calibrated in. Calibrating from a hung weight sets this to a torque unit, where the lever arm isn't used. Auto-zero takes the unloaded warm-up reading as zero torque."
        >
          <div className="fields">
            <label className="field">
              <span className="field-label">Load cell unit</span>
              <select className="input" value={unit} disabled={locked} onChange={(e) => c.setParams({ load_unit: e.target.value as SweepParams["load_unit"] })}>
                {LOAD_UNITS.map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </label>
            <NumberField name="arm_mm" label="Lever arm" unit="mm" min={0} step={0.1} />
          </div>
          <Check name="auto_zero">Auto-zero on the warm-up</Check>
          <Check name="invert_load">Invert the load sign</Check>
        </Group>

        <Group title="Filtering" help="Readings further than this many deviations from the median are dropped, then this fraction is trimmed from each end before averaging.">
          <div className="fields">
            <NumberField name="mad_k" label="MAD reject" unit="σ" min={0.5} max={20} step={0.1} />
            <NumberField name="trim" label="Trim fraction" min={0} max={0.4} step={0.05} />
          </div>
        </Group>

        <Group title="Safety" help="A step slower than the stall speed counts as stalled. The battery here is the ERC2's own, which only runs the controller.">
          <div className="fields">
            <NumberField name="stall_rpm" label="Stall below" unit="rpm" min={0} step={0.5} />
            <NumberField name="min_battery_v" label="Min ERC2 battery" unit="V" min={0} step={0.1} />
          </div>
          <Check name="stop_on_stall">Stop the sweep when the motor stalls</Check>
        </Group>
      </form>
    </div>
  );
}
