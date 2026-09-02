// @zmkfirmware/zmk-studio-ts-client is published for bundlers, not Node:
//  - relative imports have no extension ("./studio")
//  - it does `import * as _m0 from "protobufjs/minimal"`, a CommonJS module whose
//    exports Node cannot enumerate statically.
// Registered from keymap.mjs via module.registerHooks().
const SHIM = new URL("./protobufjs-minimal.mjs", import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  const fromClient = context.parentURL?.includes("/zmk-studio-ts-client/");
  if (fromClient && specifier === "protobufjs/minimal") {
    return { url: SHIM, shortCircuit: true };
  }
  try {
    return nextResolve(specifier, context);
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && fromClient) {
      for (const suffix of [".js", "/index.js"]) {
        try { return nextResolve(specifier + suffix, context); } catch { /* try next */ }
      }
    }
    throw e;
  }
}
