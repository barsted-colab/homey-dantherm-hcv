# Dantherm HCV for Homey

Homey app for Dantherm heat-recovery ventilation units, communicating locally
over **Modbus TCP**. No cloud, no manufacturer account.

Requires **Homey Pro** — Homey Cloud and Bridge have no local network access.

## Supported units

### Dantherm — verified against hardware

Tested against an HCV400 P2 (firmware 3.14). The controller reports its own
model, so all units in the family are recognised:

| Series | Models |
| --- | --- |
| HCV | HCV300 ALU, HCV400 P1/P2/E1/P1-E1, HCV460 P2/E1, HCV500 ALU, HCV700 ALU |
| HCC | HCC 2, HCC 2 ALU, HCC 2 E1 |
| RCV / RCC | RCV320 P1, RCV320 P2, RCC220 P2 |
| Other | HCH 5 MKII, WG200, WG300, WG500 |

A model the app has never heard of still pairs — it is named
`Dantherm (type N)` and works normally, since the protocol is shared across the
range.

Units sold under other brands on the same UVC controller (Pluggit Avent,
Fränkische profi-air, Bosch Vent 5000 C) speak the same registers, but are out
of scope here and untested. Note that Fränkische reports fan RPM at 162/164
instead of 100/102.

## Features

Temperatures (supply, extract, outdoor, exhaust, room), humidity, air quality,
fan speeds, bypass damper state, remaining filter life and alarm status.
Operating mode and fan level are settable. Flow cards cover mode and fan level
changes, manual bypass, filter and alarm resets, plus triggers for bypass
changes, alarms and filter replacement.

### Dashboard widget

A widget showing the heat exchange as it happens: outdoor air entering and
leaving as supply, extract air leaving as exhaust, with the recovery efficiency
between them and a fan level control underneath.

Efficiency is the temperature ratio `(supply − outdoor) / (extract − outdoor)`,
which the unit does not report itself. It is suppressed when the bypass is open,
because the exchanger is out of the loop then, and when the extract-to-outdoor
difference is under 2 °C, where sensor tolerance dominates the result.

The widget reads capability values from the paired device rather than polling
the unit, so a dashboard refreshing every few seconds cannot exhaust the
controller's three-socket limit.

**Note on the manifest.** This app uses a flat `app.json` rather than
`.homeycompose/`, and `App.hasHomeyCompose()` only returns true when that folder
exists. A `widget.compose.json` would therefore be silently ignored, so the
widget is declared under the `widgets` key in `app.json` directly — including
the `id` field, which Compose would otherwise derive from the folder name.

Widgets require `"compatibility": ">=12.3.0"`, which is why the app no longer
declares `>=5.0.0`.

### Cooling, in the terms someone actually thinks in

The controller exposes four bypass thresholds: a minimum and maximum for normal
operation, and a second pair used only in summer mode. Their names describe the
damper rather than the intent, and nothing on the screen says which one is
currently in charge.

The failure this produces is quiet. On the reference installation the house sat
at 25,7 °C with 15,0 °C outside — ten degrees of cooling standing against the
wall — and the bypass closed, because the summer minimum had been commissioned
at 17 °C. Nothing was broken and nothing was reported. A field named "summer
bypass minimum" does not tell its owner that it is the reason the house stays
warm.

So the screen now asks two questions instead of four:

    Cool down to                  23 °C   → bypass_max_temp
    Coldest outdoor air to use    12 °C   → bypass_min_temp

Summer mode's copies are mirrored from these, on every connect rather than only
when something is edited — a unit commissioned with different values would
otherwise keep its trap armed until an edit that may never come.

There is deliberately no winter setpoint. The outdoor minimum already is the
winter protection: below it the bypass stays shut, so free cooling cannot run
off with the heat you are paying for. A second number would only be another way
to say the same thing, and two settings that mean one thing is how the original
four became unreadable.

### Boosting the free cooling

The unit decides whether the bypass opens. It has no notion of wanting the house
cooler sooner, so once the damper is open the cold air arrives at whatever rate
the fans happen to be running.

With `Ventilate harder while cooling` on, the app runs the fans up while the
house is above the setpoint and the outside air is genuinely colder, then hands
the level back on arrival. Engaging needs setpoint + 0,3 K and a full degree of
outdoor advantage; releasing waits for the setpoint itself. The gap is what
keeps the fans from hunting either side of the mark.

It stays out of the way where it should. Nothing happens while the bypass is
shut, since the exchanger then tempers the incoming air back towards room
temperature and running harder would move more air while cooling nothing. Away,
night and fireplace were each chosen for a reason that outranks a degree of
comfort, and Dantherm's own summer mode stops the supply fan outright, so there
is no incoming air to speed up.

The level is borrowed rather than taken: whatever it was is remembered and
restored, and if a Flow or the wall panel moves it in the meantime, that is
treated as someone overriding on purpose and the boost is abandoned rather than
fought over. Losing a temperature reading hands the level back too — going blind
is not a reason to hold someone's fans at speed.

### Airflow and power, from your own commissioning report

The controller reports fan speed in rpm. It does not measure volume, and it has
no power register — a sweep across a 2.45x speed range found exactly ten moving
registers, all of them linear in rpm, where a wattmeter would have scaled ~14.8x.

Both figures can still be derived, but only from numbers specific to one
installation. Flow follows rpm for a fixed system curve, and fan power follows
its cube, so one reference point turns rpm into m³/h and two turn m³/h into
watts:

    Q = Q_ref · (rpm / rpm_ref)          P = P_idle + k · Q³

That is six numbers, copied from the table on the commissioning report exactly
as printed:

| | Airflow m³/h | Power W |
|---|---|---|
| Minimum | | |
| Standard | | |
| Forced | | |

Nothing else is asked for. The commissioned level is 3 on every Dantherm unit,
part of the procedure rather than a property of the installation. The reference
fan speeds are captured the first time the unit is seen running at that level —
they are the unit's own measurements, so asking the user to read them back would
be asking for a value the app already holds. Re-typing the Standard airflow
discards them, since a new figure describes a new operating point.

`P_idle` and `k` are fitted by least squares — the model is linear in Q³ — rather
than asked for, since no report states a standing draw.

Supply is not asked for, because the unit can be made to tell you. A commissioned
unit is deliberately unbalanced: extract runs a few percent above supply so the
house sits at slight negative pressure, which pulls moisture out of the
construction rather than pushing it into the walls to condense inside the
build-up. Danish practice is 4-8 %, it is fixed per installation, and no
register or report column states it as a ratio.

The exchanger does. Energy across it balances, so

    ṁ_supply · (supply − outdoor) = ṁ_extract · (extract − exhaust)

and since both streams share a density, the volume ratio is just the ratio of
the two temperature spans. On the reference installation that returns 201 m³/h
from a 216 m³/h extract — the report's own figure, to the litre.

It needs a real temperature difference to divide by, so the last good reading is
kept and used through the mild months, an implausible one (condensation on the
extract side releases latent heat this does not model) is discarded rather than
absorbed, and a unit first run in summer falls back on 6 % until the first cold
spell settles it.

Each fan is still scaled by its own speed on top of that, so the two readings
part company when the unit genuinely runs them apart — summer bypass stops the
supply fan while extract keeps going.

Recovered heat is then measured on the extract side, across the drop from
extract to exhaust, because that is the stream whose volume is known outright
rather than derived. The supply side carries the same energy by the balance
above, so taking it there would only put an estimate inside an estimate.

Every field defaults to zero and the feature stays off until filled in, because
an HCV 700 moving three times the air has its own numbers in its own report, and
a default borrowed from another installation would be a plausible-looking lie.
The two halves degrade apart: with only the Standard row you get airflow but no
power, since a single point cannot separate the standing draw from the fan power.

On the installation this was built against, the estimate lands within 1 % of the
report — 214 m³/h against 216 measured — and the fitted curve reproduces all
three power rows within 3 %.

### Self-configuring capability set

The unit is asked what it is fitted with, and the tiles follow. Two signals are
combined, because neither is sufficient alone:

1. the component bitmask from registers 2 and 610 (bypass, RH sensor, VOC
   sensor, HRC2, ServoFlow, week program), and
2. the first real reading.

The bitmask overstates: a controller will happily claim HRC2 and VOC support
while neither sensor is physically fitted, then answer `88 °C` and `0 ppm`
forever. So a capability only survives if the bitmask allows it *and* the unit
returns a plausible value. ServoFlow units get their filter condition from
register 612 and have no day counter, so that tile is dropped for them.

Optional registers are also read in their own blocks: if a unit answers
"illegal data address" for a sensor it lacks, that block degrades to null
instead of failing the entire poll. Only the registers defining the unit's basic
state (mode, fan level) are treated as fatal.

## Install

```bash
npm install --global homey     # Homey CLI, needs Node.js >= 24
homey login
homey app run --remote         # run from source on the Homey, with live logs
homey app install              # install permanently
```

`homey app run` without `--remote` runs the app in a local Docker container,
which is a poor place to test LAN broadcast discovery.

## Architecture

| Path | Purpose |
| --- | --- |
| `lib/modbus-tcp.js` | Modbus TCP client (FC3/FC16), no dependencies |
| `lib/dantherm.js` | Register map, enums, codecs, command logic |
| `lib/discovery.js` | UDP broadcast discovery |
| `drivers/hcv/` | Pairing, polling, capabilities, Flow triggers |

## Protocol notes

The details that are easy to get wrong, all verified against real hardware:

- **Every value is 32-bit** and occupies two consecutive registers (N, N+1).
  There are no 16-bit values.
- **Word order is CDAB** (word-swapped big-endian): the register at `address`
  holds the *low* word, `address + 1` the *high* word, and the bytes inside each
  register are big-endian. `Buffer.readFloatLE()` is **not** equivalent — that
  yields DCBA and produces garbage temperatures.
- Reads use **FC3**, writes use **FC16**. Input registers (FC4) are not used.
- Unit/slave ID is **1**, default port **502**.
- After a write, allow ~3 s before reading back.
- Bypass is **not** controlled by writing to the damper register (198). It goes
  through the `ACTIVE_MODE` register (168) with `0x0080` / `0x8080`.
- Away, summer and fireplace modes must be explicitly *ended* (`0x8010`,
  `0x8800`, `0x8040`) before another mode can be selected.
- An A/B switch on the PCB affects sensor-to-register mapping. Registers 84/86
  report its position; the app does not yet act on it.

Units answer a fixed UUID probe broadcast on **UDP 6400**, replying to the
ephemeral source port rather than to 6400. Some networks block broadcast across
VLANs — add the device and enter the IP manually in device settings if so.

## Tests

```bash
npm test
```

Pins the CDAB codecs against reference values from pymodbus, and runs the Modbus
client against an in-process fake controller: framing, split TCP segments,
exception replies, request serialisation and command sequencing.

## Credits

The register map traces to *Dantherm UVC Controller — Modbus TCP/IP* (rev. 3,
2015-08-21), a manufacturer specification that carries no confidentiality
marking and was published openly on Pluggit's own site from roughly 2015 to
2023. That document independently confirms the details above — 32-bit values,
CDAB float order, FC3/FC16 only, port 502, and a limit of three concurrent
sockets.

Practical groundwork came from the Home Assistant community thread and the
`Tvalley71/dantherm` integration (Apache-2.0). No code was copied — this is an
independent Node.js implementation.

## Status

Validates at `homey app validate --level publish`. Read path verified register
by register against physical hardware. **The write path (FC16) has not yet been
confirmed against a physical unit.**
