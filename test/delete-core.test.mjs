/**
 * Throwaway-tree tests for the destructive core. Run:
 *   node test/delete-core.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { findSessionDirs, isValidSessionId, removeSessionDirs, sessionsRoot } from '../lib/delete-core.js'

const base = path.join(process.cwd(), 'tmp-delete-core-test')
const root = sessionsRoot(path.join(base, 'home'))
const SESSION = 'session-580047db-893f-47ef-b319-f584351aa70c'
let checks = 0

function ok(label, condition) {
  checks += 1
  assert.ok(condition, label)
  console.log(`  ok ${checks} - ${label}`)
}

async function exists(target) {
  return stat(target).then(
    () => true,
    () => false
  )
}

await rm(base, { recursive: true, force: true })
await mkdir(path.join(root, '--D-deepseek--', SESSION), { recursive: true })
await writeFile(path.join(root, '--D-deepseek--', SESSION, 'session.v4.jsonl.zstd'), 'x')
await mkdir(path.join(root, '--D-other--', 'session-11111111-2222-3333-4444-555555555555'), { recursive: true })

console.log('isValidSessionId')
ok('accepts a real session id', isValidSessionId(SESSION))
ok('accepts a bare uuid id', isValidSessionId('4024c8da-aa2a-4db5-b58b-2173df22d594'))
ok('rejects traversal', !isValidSessionId('../etc'))
ok('rejects a path separator', !isValidSessionId('session-a/b'))
ok('rejects a backslash', !isValidSessionId('a\\b'))
ok('rejects a dot-dot body', !isValidSessionId('session-..'))
ok('rejects a leading dot', !isValidSessionId('.hidden'))
ok('rejects an empty string', !isValidSessionId(''))
ok('rejects a non-string', !isValidSessionId(42))

console.log('findSessionDirs')
const found = await findSessionDirs(root, SESSION)
ok('finds exactly the one directory', found.length === 1)
ok('resolves inside the sessions root', found[0].startsWith(path.resolve(root) + path.sep))
ok('names the session directory', path.basename(found[0]) === SESSION)
ok('rejects an invalid id loudly', await findSessionDirs(root, '../x').then(() => false, () => true))
ok('missing root yields nothing', (await findSessionDirs(path.join(base, 'nope'), SESSION)).length === 0)
ok(
  'unknown session yields nothing',
  (await findSessionDirs(root, 'session-99999999-9999-9999-9999-999999999999')).length === 0
)

console.log('removeSessionDirs')
const removed = await removeSessionDirs(found)
ok('reports the removed path', removed.length === 1 && removed[0] === found[0])
ok('directory is gone', !(await exists(found[0])))
ok('sibling project untouched', await exists(path.join(root, '--D-other--')))
ok('later scan finds nothing', (await findSessionDirs(root, SESSION)).length === 0)

await rm(base, { recursive: true, force: true })
console.log(`\n${checks} checks passed`)
