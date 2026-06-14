// Flat config (eslint 9+). Minimal baseline for a TS monorepo that was never
// linted — start lenient, tighten later. Type-aware rules are intentionally
// OFF (they need per-package tsconfig wiring and are slow); this is a syntax +
// obvious-mistake pass only.
//
// Scope: server (backend), cli (Ink/React TUI), admin (Next.js front-end).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import nextPlugin from '@next/eslint-plugin-next'

// Lenient rules shared by every linted package — calibrated to this codebase's
// deliberate idioms (see each comment for the why).
const baseRules = {
  // Unused vars: warn, and allow `_`-prefixed args (common intentional-skip idiom).
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  // This codebase uses a handful of `any` at external-lib boundaries — don't fail on it.
  '@typescript-eslint/no-explicit-any': 'off',
  // console is the deliberate logging mechanism here (intercepted by logger.ts).
  'no-console': 'off',
  // This codebase deliberately uses empty catch to swallow non-critical errors
  // (file-not-found, best-effort cleanup). Allow empty catch, still flag other
  // empty blocks (empty if/for/while are real mistakes).
  'no-empty': ['error', { allowEmptyCatch: true }],
  // eslint 10 promotes preserve-caught-error to recommended. Attaching a `cause`
  // to rethrown errors is good practice but not worth rewriting existing catch
  // blocks for — downgrade to off.
  'preserve-caught-error': 'off',
  // Conflicts with the TS idiom `let x = ''` + `try { x = ... } catch { fallback }`:
  // the initializer is required (TS errors "used before assigned" otherwise),
  // so the rule's "useless initial value" verdict is a false positive here.
  'no-useless-assignment': 'off',
}

// react-hooks rules for React component files (.tsx). The genuine violations
// (conditional hook calls, render-time ref reads) stay as errors; the noisy ones
// are downgraded with a rationale.
const reactHooksRules = {
  ...reactHooks.configs.recommended.rules,
  // Benign derived-state corrections (clamp a cursor when its list shrinks;
  // follow-the-bottom on a growing log) — all if-guarded, no render loop.
  'react-hooks/set-state-in-effect': 'warn',
  // React Compiler optimization hints, not correctness bugs: manual deps that are
  // more specific than the compiler's inference (e.g. `activeProject?.path` vs
  // `activeProject`) just skip auto-memoization — the code still works correctly.
  'react-hooks/preserve-manual-memoization': 'warn',
  // Fires on imperative DOM mutation of values reached through a ref (e.g.
  // xterm container `.style.display = ...` in an effect) — legitimate here.
  'react-hooks/immutability': 'warn',
}

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dist-pub/**', '**/out/**', '**/.next/**', '**/node_modules/**', '**/*.cjs', '**/*.mjs'],
  },
  // server: pure backend, no React.
  {
    files: ['packages/server/src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: baseRules,
  },
  // cli + admin: base rules on all source.
  {
    files: ['packages/cli/src/**/*.{ts,tsx}', 'packages/admin/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: baseRules,
  },
  // react-hooks rules. cli: ONLY .tsx — its pure-logic .ts (setup-prompts.ts,
  // whose `useRichPrompts()` is a TTY check, not a Hook) would be misjudged.
  // admin: .ts too — it has custom-hook .ts files (e.g. use-preview-fetch.ts)
  // that legitimately carry react-hooks disable comments, and no use-prefixed
  // non-hook helpers. @next plugin is registered so admin's existing
  // `@next/next/*` disable comments resolve.
  {
    files: ['packages/cli/src/**/*.tsx', 'packages/admin/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: reactHooksRules,
  },
)
