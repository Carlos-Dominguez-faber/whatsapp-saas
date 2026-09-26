// Test-runtime shim: lets `mock.module(specifier, { exports })` work on Node
// releases that predate the unified `exports` option. It landed in v25.9.0 and
// was backported to v24.15.0; older releases only understand the deprecated
// `namedExports` / `defaultExport` pair and ignore `exports`, so the mocked
// module comes out empty ("does not provide an export named ..."). On those
// releases this translates `exports` into the old shape; on newer ones it does
// nothing. Only `npm run test:unit` loads it.
import { mock } from "node:test";
import { pathToFileURL } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
const supportsExports =
  major >= 26 || (major === 25 && minor >= 9) || (major === 24 && minor >= 15);

// mock.module() resolves a relative specifier against its caller's file; once
// wrapped, the caller would be this shim, so resolve it against the test file.
function callerFileUrl() {
  const prepare = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, frames) => frames;
  const frames = new Error().stack;
  Error.prepareStackTrace = prepare;
  // [0] callerFileUrl, [1] the wrapper below, [2] the test file.
  const file = frames[2]?.getFileName();
  if (!file) return undefined;
  // ESM frames report a file: URL, CommonJS frames a plain path.
  return file.startsWith("file:") ? file : pathToFileURL(file).href;
}

// Patch the MockTracker prototype so both the global `mock` and each test's
// own `t.mock` are covered.
const tracker = Object.getPrototypeOf(mock);

if (!supportsExports && typeof tracker.module === "function") {
  const original = tracker.module;
  tracker.module = function (specifier, options = {}) {
    if (/^\.\.?\//.test(specifier)) {
      const from = callerFileUrl();
      if (from) specifier = new URL(specifier, from).href;
    }
    if (!options.exports) return original.call(this, specifier, options);
    const { exports, ...rest } = options;
    const { default: defaultExport, ...namedExports } = exports;
    return original.call(this, specifier, {
      ...rest,
      namedExports,
      ...(defaultExport !== undefined ? { defaultExport } : {}),
    });
  };
}
