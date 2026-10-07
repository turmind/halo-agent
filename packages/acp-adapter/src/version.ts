/** Reported as `agentInfo.version` on `initialize`. A literal, not a
 *  runtime package.json read: esbuild inlines this package into the cli
 *  bundle, where no adapter package.json sits beside the code. Kept equal
 *  to package.json's `version` by test/version.test.ts. */
export const ADAPTER_VERSION = '0.1.0'
