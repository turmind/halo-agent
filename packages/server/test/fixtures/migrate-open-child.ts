/**
 * Child process for legacy-migrate-lock.test.ts: one process opening a 1.x
 * session — waits for the go file (so siblings start together), opens the UI
 * log through the 2.0 reader (which converts on first open), then appends one
 * row of its own. The append is a bare O_APPEND write of an `add` record, not
 * writeUILog: two real writers are last-writer-wins by design (session-log.ts),
 * which is not what this pins — a late conversion step (replace, rollback)
 * erasing what another process already wrote is.
 *
 *   node --import tsx migrate-open-child.ts <sessionDir> <seg> <rowId> <goFile>
 *
 * Prints `RESULT {"read":<rows read>}` last. Not a test file itself.
 */
import fs from 'node:fs'
import { readUILog, uiLogPath } from '../../src/sessions/session-log.js'

const [dir, seg, rowId, goFile] = process.argv.slice(2)
while (!fs.existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)

const file = uiLogPath(dir, seg)
const rows = readUILog(file) ?? []
const m = { id: rowId, role: 'user', type: 'user', content: rowId, timestamp: Date.now() }
fs.appendFileSync(file, JSON.stringify({ t: 'add', id: rowId, u: 1, m }) + '\n')
process.stdout.write(`RESULT ${JSON.stringify({ read: rows.length })}\n`)
