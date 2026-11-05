/**
 * Suppress two always-noise Node warnings that transitive deps emit at load
 * time — a JSON-module ExperimentalWarning and the punycode DEP0040
 * DeprecationWarning — which otherwise print before the TUI even paints and
 * the user can do nothing about.
 *
 * The load-time pair is actually stopped by the bin/halo.js shim, which patches
 * emitWarning and then dynamic-imports dist/index.js — every launcher goes
 * through it (npm bin, the Windows halo.cmd, the macOS PATH launcher). This file
 * can NOT stop them: in the esbuild bundle it is inlined into the module body,
 * and ESM loads and evaluates all external deps (JSON modules included) before
 * that body runs. It only catches warnings emitted after the body starts.
 * Keep it the first import in src/index.ts so it lands as early as it can.
 */
const emit = process.emitWarning.bind(process)
process.emitWarning = (warning: string | Error, ...args: unknown[]): void => {
  const opt = args[0]
  const type = typeof opt === 'string' ? opt : (opt as { type?: string } | undefined)?.type
  if (type === 'ExperimentalWarning' || type === 'DeprecationWarning') return
  // @ts-expect-error — forwarding the original variadic call through verbatim
  return emit(warning, ...args)
}
