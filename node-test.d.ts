// @types/node's `MockModuleOptions` (even in the latest 22.x/24.x releases) only
// declares the deprecated `namedExports`/`defaultExport` fields. Node's actual
// `mock.module()` runtime (confirmed on v24.15.0) accepts a unified `exports`
// field and emits a deprecation warning for `namedExports` instead. This
// augmentation adds the current field so test files can use the
// non-deprecated API without a type error, until @types/node catches up.
declare module "node:test" {
  interface MockModuleOptions {
    exports?: object;
  }
}
