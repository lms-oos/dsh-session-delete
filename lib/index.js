/**
 * dsh-session-delete — host half.
 *
 * DSH ships archive/unarchive/pin for a Session but no delete: a conversation's
 * JSONL directory under `<DSH home>/sessions` has no owning API. This plugin
 * adds one narrow route that removes exactly one validated session directory
 * and nothing else.
 *
 * Route surface (all JSON, POST only):
 *   POST /session-delete/api/delete   { sessionId }  ->  { ok: true, removed: [...] }
 *
 * Safety rails:
 * - the id must match DSH's own `session-<uuid>` shape, so it cannot traverse
 * - the target must be `<root>/<project>/<sessionId>`, resolved and fenced
 *   inside the sessions root
 * - a Session with running work is refused (its writer would keep appending
 *   into a removed directory)
 * - only same-origin loopback requests are served (DNS-rebinding / cross-site
 *   defence, mirroring the /api gateway fence)
 *
 * @module dsh-session-delete
 */

import { homedir } from 'node:os'
import path from 'node:path'
import { dshHomeFromEnv, findSessionDirs, isValidSessionId, removeSessionDirs, sessionsRoot } from './delete-core.js'

/** Loader entry id; must match the `id` in cordis.patch.yml. */
export const name = 'dsh-session-delete'

/** The one service this plugin needs. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/session-delete/api'

/** Largest request body accepted (the payload is one session id). */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Write one JSON response.
 * @param res - node ServerResponse.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/**
 * Whether one request looks like it came from this machine's own UI.
 *
 * Not authentication — the browser already carries whatever the page carries —
 * it refuses the cross-site/DNS-rebinding shapes a hostile page could send.
 * @param req - node IncomingMessage.
 * @returns true when the request may reach the delete route.
 */
function isTrustedRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  if (!loopback) return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  return true
}

/**
 * Read a bounded JSON body.
 * @param req - node IncomingMessage.
 * @returns the parsed body, or undefined when absent/unparsable.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * The DSH home this process serves.
 * @returns absolute home directory.
 */
function resolveDshHome() {
  return dshHomeFromEnv() ?? path.join(homedir(), '.dsh')
}

/**
 * Whether a Session currently has running work (a turn in flight).
 * Best effort: an unknown shape answers "not running" so a stale service name
 * never blocks a legitimate delete.
 * @param ctx - host plugin context.
 * @param sessionId - the target session.
 * @returns true when an Agent owns this session and reports `running`.
 */
function isRunning(ctx, sessionId) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const agent = agents?.get?.(sessionId)
  return agent?.status === 'running'
}

/**
 * Park a live-but-idle Session before its files disappear.
 *
 * A Session the process still holds may have unflushed transcript writes; the
 * kernel's own order is flush → detach, and detaching announced entries is
 * what raises `session/disposed` (and therefore `api-session/removed`).
 * Every call here is defensive: if a build does not expose these members the
 * delete still proceeds, because refusing to clean a conversation the user
 * explicitly deleted is the worse failure.
 * @param ctx - host plugin context.
 * @param sessionId - the target session.
 */
async function quiesceLiveSession(ctx, sessionId) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  if (sessions === undefined || typeof sessions.get !== 'function') return
  const live = sessions.get(sessionId)
  if (live === undefined) return
  try {
    if (typeof sessions.flush === 'function') await sessions.flush(live)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-delete] flush before delete failed for ${sessionId}: ${String(error?.message ?? error)}`)
  }
  try {
    const entry = typeof sessions.liveEntryFor === 'function' ? sessions.liveEntryFor(live) : undefined
    if (entry !== undefined && typeof sessions.detachEntered === 'function') sessions.detachEntered(entry)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-delete] detach before delete failed for ${sessionId}: ${String(error?.message ?? error)}`)
  }
}

/**
 * Answer one `POST /session-delete/api/delete`.
 * @param ctx - host plugin context.
 * @param req - node IncomingMessage.
 * @param res - node ServerResponse.
 */
async function handleDelete(ctx, req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    writeJson(res, 413, { ok: false, error: { code: 'payload-too-large', message: String(error?.message ?? error) } })
    return
  }
  const sessionId = body?.sessionId
  if (!isValidSessionId(sessionId)) {
    writeJson(res, 400, { ok: false, error: { code: 'invalid-session-id', message: 'a valid sessionId is required' } })
    return
  }
  if (isRunning(ctx, sessionId)) {
    writeJson(res, 409, {
      ok: false,
      error: {
        code: 'session-running',
        message: 'this conversation is running right now — stop it first, then delete it'
      }
    })
    return
  }
  const dshHome = resolveDshHome()
  const root = sessionsRoot(dshHome)
  let dirs
  try {
    dirs = await findSessionDirs(root, sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-delete] scan failed under ${root}: ${String(error?.message ?? error)}`)
    writeJson(res, 500, { ok: false, error: { code: 'scan-failed', message: String(error?.message ?? error) } })
    return
  }
  if (dirs.length === 0) {
    writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'no stored files for this conversation' } })
    return
  }
  await quiesceLiveSession(ctx, sessionId)
  let removed
  try {
    removed = await removeSessionDirs(dirs)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-delete] delete failed for ${sessionId}: ${String(error?.message ?? error)}`)
    writeJson(res, 500, { ok: false, error: { code: 'delete-failed', message: String(error?.message ?? error) } })
    return
  }
  // Verify, because a partially removed tree and a fully removed one must not
  // report the same thing (`rm` is recursive but not atomic).
  const leftover = await findSessionDirs(root, sessionId).catch(() => [])
  if (leftover.length > 0) {
    ctx.logger?.warn?.(`[dsh-session-delete] ${sessionId} still present after removal: ${leftover.join(', ')}`)
    writeJson(res, 500, {
      ok: false,
      error: {
        code: 'incomplete',
        message: 'the conversation was only partly removed — close DSH and retry, or delete the directory by hand'
      }
    })
    return
  }
  // The one signal that removes the row from every connected sidebar at once;
  // the list itself is derived from host state, so a stale index entry would
  // otherwise keep rendering until the next restart.
  try {
    if (typeof ctx.emit === 'function') ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-delete] removal broadcast failed for ${sessionId}: ${String(error?.message ?? error)}`)
  }
  ctx.logger?.info?.(`[dsh-session-delete] removed ${sessionId} (${removed.length} dir)`)
  writeJson(res, 200, { ok: true, sessionId, removed: removed.map((dir) => path.relative(root, dir)) })
}

/**
 * Register the delete route.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          if (!isTrustedRequest(req)) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
            return
          }
          if (url.pathname === `${ROUTE_PREFIX}/delete`) {
            await handleDelete(ctx, req, res)
            return
          }
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${url.pathname}` } })
        }
      }),
    'session-delete: delete route'
  )
}
