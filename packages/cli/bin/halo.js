#!/usr/bin/env node
// Node-version gate first, then the real entry via dynamic import(): a static
// import is evaluated before this check, and on an old Node the bundle dies
// mid-parse with an error that never names Node (v18: "Invalid regular
// expression flags"). Keep this file parseable by old Node. The published
// shim (scripts/build-bundle.mjs SHIM) carries the same check.
const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  process.stderr.write(`halo requires Node.js 22 or newer (found ${process.version}). Upgrade: https://nodejs.org/ (or \`nvm install 22\`)\n`)
  process.exit(1)
}
await import('../dist/index.js')
