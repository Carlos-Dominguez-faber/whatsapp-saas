// Test-runtime shim: lets `mock.module(specifier, { exports })` work on Node
// releases that predate the unified `exports` option (it landed in v24.15.0;
// older 22.x/24.x only understand the now-deprecated `namedExports` /
// `defaultExport` pair and silently ignore `exports`, so the mock never
// applies). On those releases this translates `exports` into the old shape;
// on newer ones it does nothing. Only `npm run test:unit` loads it.
import { mock } from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supportsExports = major > 24 || (major === 24 && minor >= 15);

if (!supportsExports && typeof mock.module === "function") {
  const original = mock.module.bind(mock);
  mock.module = (specifier, options = {}) => {
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
