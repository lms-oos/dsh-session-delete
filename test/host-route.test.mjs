/**
 * Host-route behaviour tests with a mocked Cordis context, request and
 * response — no live DSH needed. Run:
 *   node test/host-route.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

const base = path.join(process.cwd(), 'tmp-host-route-test')
const home = path.join(base, 'home')
const root = path.join(home, 'sessions')
const SESSION = 'session-580047db-893f-47ef-b319-f584351aa70c'
const OTHER = 'session-11111111-2222-3333-4444-555555555555'
const BARE = '4024c8da-aa2a-4db5-b58b-2173df22d594'
let checks = 0

function ok(label, condition) {
  checks += 1
  assert.ok(condition, `${label} (check ${checks})`)
  console.log(`  ok ${checks} - ${label}`)
}

async function exists(target) {
  return stat(target).then(
    () => true,
    () => false
  )
}

function makeReq({ method = 'POST', url = '/session-delete/api/delete', headers = {}, body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin', ...headers }
  return stream
}

function makeRes() {
  const captured = { status: 0, json: undefined }
  return {
    captured,
    writeHead(status) {
      captured.status = status
    },
    end(chunk) {
      captured.json = chunk === undefined ? undefined : JSON.parse(chunk.toString())
    }
  }
}

/** Mount the plugin against a mock context; returns its handler and emitted events. */
function mount({ agents, sessions } = {}) {
  const routes = []
  const events = []
  const ctx = {
    effect: (fn) => fn(),
    emit: (event, payload) => {
      events.push([event, payload])
    },
    logger: { info() {}, warn() {} },
    get: (key) => (key === 'agents' ? agents : key === 'sessions' ? sessions : undefined),
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      }
    }
  }
  apply(ctx)
  assert.equal(routes.length, 1, 'one route registered')
  return { handler: routes[0].handler, events }
}

async function call(handler, options) {
  const res = makeRes()
  await handler(makeReq(options), res)
  return res.captured
}

await rm(base, { recursive: true, force: true })
await mkdir(path.join(root, '--D-deepseek--', SESSION), { recursive: true })
await writeFile(path.join(root, '--D-deepseek--', SESSION, 'session.v4.jsonl.zstd'), 'x')
await mkdir(path.join(root, '--D-deepseek--', OTHER), { recursive: true })
await mkdir(path.join(root, '--D-deepseek--', BARE), { recursive: true })
await mkdir(path.join(base, 'elsewhere', SESSION), { recursive: true })

// The route resolves its home from DSH_HOME at call time.
process.env.DSH_HOME = home

const { handler, events } = mount()

console.log('routing guards')
ok('rejects GET with 405', (await call(handler, { method: 'GET' })).status === 405)
ok(
  'rejects a non-loopback host with 403',
  (await call(handler, { headers: { host: 'evil.example.com' } })).status === 403
)
ok(
  'rejects cross-site markers with 403',
  (await call(handler, { headers: { 'sec-fetch-site': 'cross-site' } })).status === 403
)
ok(
  'unknown route answers 404',
  (await call(handler, { url: '/session-delete/api/other' })).status === 404
)
ok('missing sessionId answers 400', (await call(handler, { body: {} })).status === 400)
ok('traversal id answers 400', (await call(handler, { body: { sessionId: '../../etc' } })).status === 400)
ok(
  'unknown session answers 404',
  (await call(handler, { body: { sessionId: 'session-99999999-9999-9999-9999-999999999999' } })).status === 404
)

console.log('running-work guard')
const running = mount({ agents: { get: () => ({ status: 'running' }) } })
const runningResult = await call(running.handler, { body: { sessionId: SESSION } })
ok('running session answers 409', runningResult.status === 409)
ok('running session reports the code', runningResult.json.error.code === 'session-running')
ok('running session is still on disk', await exists(path.join(root, '--D-deepseek--', SESSION)))
ok('running session is not broadcast as removed', running.events.length === 0)

console.log('deletion')
const deleted = await call(handler, { body: { sessionId: SESSION } })
ok('answers 200', deleted.status === 200)
ok('reports ok', deleted.json.ok === true)
ok('names the session', deleted.json.sessionId === SESSION)
ok('reports a relative path', deleted.json.removed.length === 1 && !path.isAbsolute(deleted.json.removed[0]))
ok('session directory is gone', !(await exists(path.join(root, '--D-deepseek--', SESSION))))
ok('sibling session untouched', await exists(path.join(root, '--D-deepseek--', OTHER)))
ok('same id outside the root untouched', await exists(path.join(base, 'elsewhere', SESSION)))
ok('second delete answers 404', (await call(handler, { body: { sessionId: SESSION } })).status === 404)
ok(
  'broadcasts api-session/removed',
  events.some(([event, payload]) => event === 'api-session/removed' && payload === SESSION)
)

console.log('bare-uuid session id')
const bare = await call(handler, { body: { sessionId: BARE } })
ok('a prefix-less id is accepted', bare.status === 200)
ok('its directory is gone', !(await exists(path.join(root, '--D-deepseek--', BARE))))

console.log('live but idle session')
let flushed = false
let detached = false
const live = mount({
  sessions: {
    get: () => ({ id: OTHER }),
    flush: async () => {
      flushed = true
    },
    liveEntryFor: () => ({ announced: true }),
    detachEntered: () => {
      detached = true
    }
  }
})
const liveResult = await call(live.handler, { body: { sessionId: OTHER } })
ok('an idle live session is deleted', liveResult.status === 200)
ok('flushed before removing files', flushed === true)
ok('detached before removing files', detached === true)
ok('its directory is gone', !(await exists(path.join(root, '--D-deepseek--', OTHER))))

await rm(base, { recursive: true, force: true })
console.log(`\n${checks} checks passed`)
