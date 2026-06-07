/**
 * Suppress two always-noise Node warnings that transitive deps emit at load
 * time — a JSON-module ExperimentalWarning and the punycode DEP0040
 * DeprecationWarning — which otherwise print before the TUI even paints and
 * the user can do nothing about.
 *
 * This MUST be the very first import in src/index.ts: ESM evaluates imports in
 * order, and these warnings fire while the dependency graph loads, so the patch
 * has to land before any other import is evaluated. (The bin/halo.js shim also
 * patches this, but the desktop app's PATH launcher execs dist/index.js
 * directly, bypassing that shim — so the guard lives here at the real entry.)
 */
const emit = process.emitWarning.bind(process)
process.emitWarning = (warning: string | Error, ...args: unknown[]): void => {
  const opt = args[0]
  const type = typeof opt === 'string' ? opt : (opt as { type?: string } | undefined)?.type
  if (type === 'ExperimentalWarning' || type === 'DeprecationWarning') return
  // @ts-expect-error — forwarding the original variadic call through verbatim
  return emit(warning, ...args)
}
