#!/usr/bin/env node
// Back up and restore the keymap stored on a ZMK keyboard through the ZMK
// Studio RPC over USB serial.
//
//   node keymap.mjs dump    [file.json]            save the live keymap
//   node keymap.mjs restore  file.json [--dry-run]  write a saved keymap back
//   node keymap.mjs show     file.json              print a saved keymap
//
// Options: --port /dev/ttyACMx   use a specific serial port
//
// The firmware must be built with ZMK Studio support, and the keyboard must be
// unlocked (press the &studio_unlock key when prompted). Behaviors are matched
// by their display name, not their numeric id, so a dump survives a rebuild.

import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { Readable, Writable } from "node:stream";
import { SerialPort } from "serialport";

// The Studio client needs a resolver shim (see esm-hooks.mjs); register it
// before the dynamic import below so a plain `node keymap.mjs` works.
registerHooks(await import("./esm-hooks.mjs"));
const { create_rpc_connection, call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");

const FORMAT = "zmk-studio-keymap/1";
const ZMK_USB = { vendorId: "1d50", productId: "615e" };
const LOCKED = 0;

// Display only: turn ZMK's packed keycodes (mods << 24 | page << 16 | usage)
// into the familiar names. Anything unknown is printed as the raw number.
const KEYS = {
  0x04: "A", 0x05: "B", 0x06: "C", 0x07: "D", 0x08: "E", 0x09: "F", 0x0a: "G", 0x0b: "H", 0x0c: "I", 0x0d: "J",
  0x0e: "K", 0x0f: "L", 0x10: "M", 0x11: "N", 0x12: "O", 0x13: "P", 0x14: "Q", 0x15: "R", 0x16: "S", 0x17: "T",
  0x18: "U", 0x19: "V", 0x1a: "W", 0x1b: "X", 0x1c: "Y", 0x1d: "Z", 0x1e: "N1", 0x1f: "N2", 0x20: "N3", 0x21: "N4",
  0x22: "N5", 0x23: "N6", 0x24: "N7", 0x25: "N8", 0x26: "N9", 0x27: "N0", 0x28: "RET", 0x29: "ESC", 0x2a: "BSPC",
  0x2b: "TAB", 0x2c: "SPACE", 0x2d: "MINUS", 0x2e: "EQUAL", 0x2f: "LBKT", 0x30: "RBKT", 0x31: "BSLH", 0x32: "NUHS",
  0x33: "SEMI", 0x34: "SQT", 0x35: "GRAVE", 0x36: "COMMA", 0x37: "DOT", 0x38: "FSLH", 0x39: "CAPS",
  0x3a: "F1", 0x3b: "F2", 0x3c: "F3", 0x3d: "F4", 0x3e: "F5", 0x3f: "F6", 0x40: "F7", 0x41: "F8", 0x42: "F9",
  0x43: "F10", 0x44: "F11", 0x45: "F12", 0x46: "PSCRN", 0x47: "SLCK", 0x48: "PAUSE", 0x49: "INS", 0x4a: "HOME",
  0x4b: "PG_UP", 0x4c: "DEL", 0x4d: "END", 0x4e: "PG_DN", 0x4f: "RIGHT", 0x50: "LEFT", 0x51: "DOWN", 0x52: "UP",
  0x53: "KP_NUM", 0x54: "KP_SLASH", 0x55: "KP_MULTIPLY", 0x56: "KP_MINUS", 0x57: "KP_PLUS", 0x58: "KP_ENTER",
  0x59: "KP_N1", 0x5a: "KP_N2", 0x5b: "KP_N3", 0x5c: "KP_N4", 0x5d: "KP_N5", 0x5e: "KP_N6", 0x5f: "KP_N7",
  0x60: "KP_N8", 0x61: "KP_N9", 0x62: "KP_N0", 0x63: "KP_DOT", 0x64: "NUBS", 0x65: "K_APP",
  0x7f: "K_MUTE", 0x80: "K_VOL_UP", 0x81: "K_VOL_DN",
  0xe0: "LCTRL", 0xe1: "LSHFT", 0xe2: "LALT", 0xe3: "LGUI", 0xe4: "RCTRL", 0xe5: "RSHFT", 0xe6: "RALT", 0xe7: "RGUI",
};
const CONSUMER = {
  0xb5: "C_NEXT", 0xb6: "C_PREV", 0xb7: "C_STOP", 0xcd: "C_PP", 0xe2: "C_MUTE", 0xe9: "C_VOL_UP", 0xea: "C_VOL_DN",
  0x6f: "C_BRI_UP", 0x70: "C_BRI_DN", 0x223: "C_AC_HOME", 0x224: "C_AC_BACK", 0x225: "C_AC_FORWARD", 0x227: "C_AC_REFRESH",
};
const MODS = [[0x01, "LC"], [0x02, "LS"], [0x04, "LA"], [0x08, "LG"], [0x10, "RC"], [0x20, "RS"], [0x40, "RA"], [0x80, "RG"]];

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--") && !a.includes("=")));
const portOverride = args.find((a, i) => args[i - 1] === "--port");
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
const [command, fileArg] = positional;

if (!["dump", "restore", "show"].includes(command)) {
  console.error(`usage:
  keymap.mjs dump    [file.json]
  keymap.mjs restore  file.json [--dry-run]
  keymap.mjs show     file.json
options: --port /dev/ttyACMx`);
  process.exit(2);
}

if (command === "show") {
  printKeymap(loadDump(fileArg));
  process.exit(0);
}

const port = await openPort(portOverride);
const conn = create_rpc_connection(port.transport);
const lock = watchLock(conn);

try {
  const rpc = (req) => call_rpc(conn, req);
  const info = (await rpc({ core: { getDeviceInfo: true } })).core.getDeviceInfo;
  const device = { name: info.name, serial: Buffer.from(info.serialNumber).toString("hex") };
  console.error(`connected to ${device.name} (serial ${device.serial}) on ${port.path}`);

  await ensureUnlocked(rpc, lock);

  if (command === "dump") await dump(rpc, device, fileArg);
  else await restore(rpc, device, fileArg, flags.has("--dry-run"));
} finally {
  await port.close();
}
process.exit(0);

// ---------------------------------------------------------------- dump

async function dump(rpc, device, file) {
  const keymap = (await rpc({ keymap: { getKeymap: true } })).keymap.getKeymap;
  const names = await behaviorNames(rpc);

  const out = {
    format: FORMAT,
    dumpedAt: new Date().toISOString(),
    device,
    availableLayers: keymap.availableLayers,
    layers: keymap.layers.map((l) => ({
      name: l.name,
      bindings: l.bindings.map((b) => ({
        behavior: names.get(b.behaviorId) ?? `#${b.behaviorId}`,
        param1: b.param1 ?? 0,
        param2: b.param2 ?? 0,
      })),
    })),
  };

  const stamp = out.dumpedAt.slice(0, 19).replace(/[:T]/g, "-");
  const target = file ?? `keymap-${device.name.toLowerCase()}-${stamp}.json`;
  writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  const keys = out.layers[0]?.bindings.length ?? 0;
  console.error(`saved ${out.layers.length} layers x ${keys} keys to ${target}`);
  printKeymap(out);
}

// ---------------------------------------------------------------- restore

async function restore(rpc, device, file, dryRun) {
  const saved = loadDump(file);
  if (saved.device.name !== device.name) {
    console.error(`warning: dump is from "${saved.device.name}", keyboard is "${device.name}"`);
  }

  const names = await behaviorNames(rpc);
  const ids = new Map([...names].map(([id, name]) => [name, id]));
  const missing = new Set();
  for (const l of saved.layers) for (const b of l.bindings) if (!ids.has(b.behavior)) missing.add(b.behavior);
  if (missing.size) {
    console.error(`error: this firmware has no behavior named: ${[...missing].join(", ")}`);
    process.exit(1);
  }

  let live = (await rpc({ keymap: { getKeymap: true } })).keymap.getKeymap;
  const plan = [];

  // 1. Layer count.
  for (let i = live.layers.length; i < saved.layers.length; i++) plan.push({ op: "addLayer" });
  for (let i = live.layers.length - 1; i >= saved.layers.length; i--) plan.push({ op: "removeLayer", index: i });

  if (!dryRun) {
    for (const step of plan) {
      if (step.op === "addLayer") {
        const r = (await rpc({ keymap: { addLayer: {} } })).keymap.addLayer;
        if (r.err !== undefined) throw new Error(`addLayer failed: ${r.err}`);
      } else {
        const r = (await rpc({ keymap: { removeLayer: { layerIndex: step.index } } })).keymap.removeLayer;
        if (r.err !== undefined) throw new Error(`removeLayer ${step.index} failed: ${r.err}`);
      }
    }
    if (plan.length) live = (await rpc({ keymap: { getKeymap: true } })).keymap.getKeymap;
  }

  // 2. Names and bindings, only where they differ.
  let renamed = 0, changed = 0;
  for (let i = 0; i < saved.layers.length; i++) {
    const want = saved.layers[i];
    const have = live.layers[i]; // undefined in a dry run that would add layers
    const layerId = have?.id;

    if (!have || have.name !== want.name) {
      renamed++;
      plan.push({ op: "rename", layer: i, name: want.name });
      if (!dryRun) {
        const r = (await rpc({ keymap: { setLayerProps: { layerId, name: want.name } } })).keymap.setLayerProps;
        if (r !== 0) throw new Error(`rename layer ${i} failed: ${r}`);
      }
    }

    if (have && have.bindings.length !== want.bindings.length) {
      throw new Error(`layer ${i}: keyboard has ${have.bindings.length} keys, dump has ${want.bindings.length}`);
    }

    for (let k = 0; k < want.bindings.length; k++) {
      const w = want.bindings[k];
      const h = have?.bindings[k];
      const wantId = ids.get(w.behavior);
      const same = h && h.behaviorId === wantId && (h.param1 ?? 0) === w.param1 && (h.param2 ?? 0) === w.param2;
      if (same) continue;
      changed++;
      plan.push({ op: "bind", layer: i, key: k, from: h ? fmt(names.get(h.behaviorId), h) : "-", to: fmt(w.behavior, w) });
      if (!dryRun) {
        const r = (await rpc({ keymap: { setLayerBinding: { layerId, keyPosition: k, binding: { behaviorId: wantId, param1: w.param1, param2: w.param2 } } } })).keymap.setLayerBinding;
        if (r !== 0) throw new Error(`layer ${i} key ${k} -> ${fmt(w.behavior, w)} failed: ${["ok", "invalid location", "invalid behavior", "invalid parameters"][r] ?? r}`);
      }
    }
  }

  for (const p of plan) {
    if (p.op === "bind") console.error(`  L${p.layer} key ${String(p.key).padStart(2)}: ${p.from}  ->  ${p.to}`);
    else if (p.op === "rename") console.error(`  L${p.layer}: rename to "${p.name}"`);
    else console.error(`  ${p.op}${p.index !== undefined ? " " + p.index : ""}`);
  }

  if (!plan.length) { console.error("keyboard already matches the dump; nothing to do"); return; }
  if (dryRun) { console.error(`dry run: ${changed} bindings, ${renamed} names, ${plan.length - changed - renamed} layer ops would change`); return; }

  const save = (await rpc({ keymap: { saveChanges: true } })).keymap.saveChanges;
  if (save.err !== undefined && save.err !== 0) {
    throw new Error(`saveChanges failed: ${["ok", "generic", "not supported", "no space"][save.err] ?? save.err}`);
  }
  console.error(`restored: ${changed} bindings, ${renamed} names, ${plan.length - changed - renamed} layer ops; saved to flash`);
}

// ---------------------------------------------------------------- helpers

async function behaviorNames(rpc) {
  const ids = (await rpc({ behaviors: { listAllBehaviors: true } })).behaviors.listAllBehaviors.behaviors;
  const names = new Map();
  for (const id of ids) {
    const d = (await rpc({ behaviors: { getBehaviorDetails: { behaviorId: id } } })).behaviors.getBehaviorDetails;
    names.set(id, d.displayName);
  }
  return names;
}

async function ensureUnlocked(rpc, lock) {
  let state = (await rpc({ core: { getLockState: true } })).core.getLockState;
  if (state !== LOCKED) return;
  console.error("keyboard is locked: press the studio_unlock key now (waiting up to 60s)");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (lock.state !== undefined && lock.state !== LOCKED) return;
    await new Promise((r) => setTimeout(r, 500));
    state = (await rpc({ core: { getLockState: true } })).core.getLockState;
    if (state !== LOCKED) return;
  }
  throw new Error("keyboard still locked");
}

function watchLock(conn) {
  const lock = { state: undefined };
  (async () => {
    const reader = conn.notification_readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value.core?.lockStateChanged !== undefined) lock.state = value.core.lockStateChanged;
      }
    } catch { /* connection closed */ }
  })();
  return lock;
}

async function openPort(override) {
  let path = override;
  if (!path) {
    const ports = await SerialPort.list();
    const zmk = ports.filter((p) => p.vendorId?.toLowerCase() === ZMK_USB.vendorId && p.productId?.toLowerCase() === ZMK_USB.productId);
    if (!zmk.length) throw new Error("no ZMK keyboard found on USB (need a Studio-enabled build, plugged in)");
    if (zmk.length > 1) console.error(`several ZMK ports found, using ${zmk[0].path}; override with --port`);
    path = zmk[0].path;
  }
  const serial = new SerialPort({ path, baudRate: 115200 });
  await new Promise((res, rej) => serial.once("open", res).once("error", rej));
  const abortController = new AbortController();
  const transport = {
    label: path,
    abortController,
    readable: Readable.toWeb(serial),
    writable: Writable.toWeb(serial),
  };
  return {
    path,
    transport,
    close: () => new Promise((res) => serial.close(() => res())),
  };
}

function loadDump(file) {
  if (!file) { console.error("a dump file is required"); process.exit(2); }
  const d = JSON.parse(readFileSync(file, "utf8"));
  if (d.format !== FORMAT) throw new Error(`unexpected file format "${d.format}"`);
  return d;
}

function fmt(name, b) {
  const p = [b.param1, b.param2].filter((v, i, a) => v !== 0 || a.slice(i + 1).some((x) => x !== 0));
  return p.length ? `${name}(${p.map(keyName).join(",")})` : name;
}

function keyName(v) {
  const page = (v >>> 16) & 0xff, usage = v & 0xffff, mods = (v >>> 24) & 0xff;
  let base;
  if (page === 0x07) base = KEYS[usage];
  else if (page === 0x0c) base = CONSUMER[usage];
  if (base === undefined) return String(v);
  for (const [bit, name] of MODS) if (mods & bit) base = `${name}(${base})`;
  return base;
}

function printKeymap(d) {
  console.log(`${d.device.name}  ${d.layers.length} layers  dumped ${d.dumpedAt}`);
  d.layers.forEach((l, i) => {
    console.log(`\n[${i}] ${l.name || "(unnamed)"}`);
    const cells = l.bindings.map((b) => fmt(b.behavior, b));
    const w = Math.max(...cells.map((c) => c.length));
    const perRow = cells.length === 34 ? 10 : Math.ceil(Math.sqrt(cells.length) * 1.5);
    for (let r = 0; r < cells.length; r += perRow) {
      console.log("  " + cells.slice(r, r + perRow).map((c) => c.padEnd(w)).join(" "));
    }
  });
}
