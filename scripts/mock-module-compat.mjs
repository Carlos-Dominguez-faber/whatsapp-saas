// Test-runtime shim: lets `mock.module(specifier, { exports })` work on Node
// releases that predate the unified `exports` option (it landed in v24.15.0;
// older 22.x/24.x only understand the now-deprecated `namedExports` /
// `defaultExport` pair and silently ignore `exports`, so the mock never
// applies). On those releases this translates `exports` into the old shape;
// on newer ones it does nothing. Only `npm run test:unit` loads it.
import { mock } from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supportsExports = major > 24 || (major === 24 && minor >= 15);

// mock.module() resolves a relative specifier against its caller's file; once
// wrapped, the caller would be this shim, so resolve it against the test file.
function callerFileUrl() {
  const prepare = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, frames) => frames;
  const frames = new Error().stack;
  Error.prepareStackTrace = prepare;
  // [0] callerFileUrl, [1] the wrapper below, [2] the test file.
  return frames[2]?.getFileName() ?? undefined;
}

if (!supportsExports && typeof mock.module === "function") {
  const original = mock.module.bind(mock);
  mock.module = (specifier, options = {}) => {
    if (/^\.\.?\//.test(specifier)) {
      const from = callerFileUrl();
      if (from) specifier = new URL(specifier, from).href;
    }
    if (!options.exports) return original(specifier, options);
    const { exports, ...rest } = options;
    const { default: defaultExport, ...namedExports } = exports;
    return original(specifier, {
      ...rest,
      namedExports,
      ...(defaultExport !== undefined ? { defaultExport } : {}),
    });
  };
}
