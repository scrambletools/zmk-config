# ZMK keymap backup and restore

Back up the keymap that lives on a ZMK keyboard, including every change made
in ZMK Studio, and load it back later. ZMK Studio has no export, and a
`settings_reset` flash wipes the on-board keymap, so this is the safety net.

The tool talks to the keyboard over USB using the same protocol ZMK Studio
uses. It never touches the firmware or the compiled keymap in `config/`; it
only reads and writes the layout stored in the keyboard's settings.

## Requirements

- **Firmware built with ZMK Studio support.** `build.yaml` in this repo does
  that for the left half via the `studio-rpc-usb-uart` snippet. The plain
  build without Studio will not respond.
- **The left (central) half plugged into USB.** On a split keyboard only the
  central half runs Studio. The right half is never involved.
- **Node.js.** Installed on this machine through mise.
- **ZMK Studio disconnected.** Only one program can hold the serial port. Click
  Disconnect in Studio, or close it, before running the tool.
- **Serial port access.** The udev rule in `/etc/udev/rules.d/60-zmk-studio.rules`
  grants the logged-in user access to any ZMK keyboard's port. Without it you
  would need to be in the `uucp` group.

## Setup

Once, after cloning the repo:

```sh
cd tools/keymap
npm install
```

`.npmrc` disables install scripts because the Studio client package ships a
postinstall step that only works inside its own development checkout.

## Back up

```sh
cd tools/keymap
node keymap.mjs dump
```

The tool finds the keyboard on USB, connects, and if the keyboard is locked
prints:

```
keyboard is locked: press the studio_unlock key now (waiting up to 60s)
```

Press the key bound to `&studio_unlock` (bottom-right thumb key on the Symbol
layer in the current layout). The dump then completes and writes a file named
after the keyboard and the time, for example
`keymap-cradio-2026-09-02-01-31-49.json`, and prints the layout:

```
connected to Cradio (serial b5a1927cf59316eb) on /dev/ttyACM0
saved 4 layers x 34 keys to keymap-cradio-2026-09-02-01-31-49.json
Cradio  4 layers  dumped 2026-09-02T01:31:49.403Z

[0] Alpha
  Key Press(Q)  Key Press(W)  Key Press(E) ...
  home_row_mod_left(LSHFT,A)  home_row_mod_left(LALT,S) ...
```

To choose the file name:

```sh
node keymap.mjs dump my-layout.json
```

Commit the dump to the repo so it is versioned alongside the firmware config.

## View a backup

```sh
node keymap.mjs show keymap-cradio-2026-09-02-01-31-49.json
```

Prints the layers as a grid without connecting to the keyboard. Keycodes are
decoded into ZMK names (`Q`, `LS(N3)`, `Layer-Tap(1,BSPC)`). A number that
the decoder does not know is printed as-is.

## Restore

Always preview first. This connects to the keyboard, compares the file with
what is on the board, and lists the differences without changing anything:

```sh
node keymap.mjs restore keymap-cradio-2026-09-02-01-31-49.json --dry-run
```

```
connected to Cradio (serial b5a1927cf59316eb) on /dev/ttyACM0
  L0 key  0: Key Press(Q)  ->  Key Press(W)
  L1: rename to "Numbers"
dry run: 1 bindings, 1 names, 0 layer ops would change
```

If the keyboard already matches it says so and stops. When the preview looks
right, run it for real:

```sh
node keymap.mjs restore keymap-cradio-2026-09-02-01-31-49.json
```

Restore works in this order and then saves to flash:

1. Adds or removes layers until the count matches the file.
2. Renames layers whose name differs.
3. Rewrites only the bindings that differ.

Typical flows:

- **After a `settings_reset` flash.** Flash the normal firmware, plug in the
  left half, run `restore`. The layout comes back exactly.
- **After a firmware rebuild.** Usually nothing to do; the settings partition
  survives a normal flash. Run `restore --dry-run` to confirm it still matches.
- **Trying a layout change.** `dump` first, experiment in Studio, and if you
  do not like it, `restore` the dump.

## Options

| Option | Meaning |
|---|---|
| `--port /dev/ttyACM1` | Use a specific serial port instead of finding the keyboard by USB id |
| `--dry-run` | With `restore`: report differences, write nothing |

## The file format

```json
{
  "format": "zmk-studio-keymap/1",
  "dumpedAt": "2026-09-02T01:31:49.403Z",
  "device": { "name": "Cradio", "serial": "b5a1927cf59316eb" },
  "availableLayers": 8,
  "layers": [
    {
      "name": "Alpha",
      "bindings": [
        { "behavior": "Key Press", "param1": 458772, "param2": 0 },
        ...
      ]
    }
  ]
}
```

Each binding is the behavior's **display name** and its two parameters. The
name, not the numeric behavior id, is what gets stored, because ids can change
between firmware builds and names do not. On restore the tool asks the running
firmware for its behaviors, matches by name, and refuses to run if the file
uses a behavior the firmware does not have.

Parameters are ZMK's packed keycodes: `mods << 24 | page << 16 | usage`. For
example `458772` is `0x70014`, keyboard page usage `0x14`, which is `Q`. The
file keeps the raw numbers so a restore is exact; only `show` decodes them.

## Troubleshooting

**`no ZMK keyboard found on USB`**
The left half is not plugged in, or the firmware on it was built without
Studio. Check with `ls /dev/ttyACM*`; a Studio build creates a serial port.

**`Failed to open the serial port` or a permission error**
ZMK Studio is still connected, or the udev rule is missing. `fuser
/dev/ttyACM0` shows who holds the port.

**`keyboard still locked`**
The unlock key was not pressed within 60 seconds. Run again and press it when
prompted. Studio unlock is per session; unplugging re-locks the keyboard.

**`this firmware has no behavior named: ...`**
The dump uses a behavior that the current firmware does not include. Either
the keymap in `config/` lost a behavior definition, or the dump came from a
different keyboard.

**`layer N: keyboard has X keys, dump has Y`**
The dump is from a keyboard with a different physical layout. Restore stops
before writing anything.

## How it is put together

- `keymap.mjs` is the whole tool.
- `esm-hooks.mjs` and `protobufjs-minimal.mjs` let Node load
  `@zmkfirmware/zmk-studio-ts-client`, which is published for bundlers:
  its relative imports have no `.js` extension and it imports the CommonJS
  `protobufjs/minimal` as an ES namespace. Neither works in plain Node without
  these two shims.
- `serialport` provides the USB serial connection.
