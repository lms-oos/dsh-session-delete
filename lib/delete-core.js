/**
 * Session deletion core: locate and remove the on-disk directory of one
 * persisted Session.
 *
 * Deliberately free of Cordis and of any HTTP concern so the destructive part
 * can be unit-tested against a throwaway tree (see `test/delete-core.test.mjs`).
 *
 * Layout facts this relies on (DSH 0.2.0-rc.2, `@deepseek-ai/dsh-session-persistence-jsonl`):
 * - the backend root is the DSH home's `sessions` directory
 * - one session owns `<root>/<projectKey(cwd)>/<encoded session id>/`
 * - the encoded session id IS the session id for every id DSH mints
 *   (`session-<uuid>`), so the directory name can be matched directly instead
 *   of re-deriving `projectKey(cwd)` here.
 *
 * @module dsh-session-delete/delete-core
 */

import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Shape of one usable session directory name.
 *
 * DSH mints more than one id form: ordinary sessions look like
 * `session-<uuid>`, while some in-process children are stored under a bare
 * UUID. Both are plain path segments, and `encodeSegment()` is the identity
 * for exactly this character set — so the rule is "a safe single path
 * segment", not "starts with `session-`".
 */
const SESSION_DIR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/**
 * Whether one caller-supplied value may be used as a session directory name.
 * @param value - untrusted candidate.
 * @returns true when the value is a plausible, traversal-free session id.
 */
export function isValidSessionId(value) {
  if (typeof value !== 'string') return false
  if (!SESSION_DIR_NAME_PATTERN.test(value)) return false
  if (value.includes('..')) return false
  return true
}

/**
 * The persistence root for one DSH home.
 * @param dshHome - absolute DSH home directory.
 * @returns the `sessions` directory beneath it.
 */
export function sessionsRoot(dshHome) {
  return path.join(dshHome, 'sessions')
}

/**
 * Resolve the DSH home from an environment bag (injected so it is testable).
 * @param env - environment variables (defaults to `process.env`).
 * @returns the configured home, or undefined when unset/blank.
 */
export function dshHomeFromEnv(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured === '' ? undefined : configured
}

/**
 * Every existing `<root>/<project>/<sessionId>` directory for one session.
 *
 * Scans the project directories instead of re-deriving the project key from
 * the session header: the id-to-directory mapping is then the only rule that
 * has to hold, and a session whose files live under an unexpected project
 * directory is still found (and still reported) rather than silently missed.
 *
 * @param root - the persistence root (`<dsh home>/sessions`).
 * @param sessionId - validated session id.
 * @returns absolute session directory paths, in directory-listing order.
 * @throws {Error} when the id is not a plausible session id.
 */
export async function findSessionDirs(root, sessionId) {
  if (!isValidSessionId(sessionId)) throw new Error(`refusing to resolve an invalid session id: ${String(sessionId)}`)
  const found = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return found
    throw error
  }
  const rootResolved = path.resolve(root)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const projectDir = path.resolve(rootResolved, entry.name)
    const candidate = path.resolve(projectDir, sessionId)
    // Containment guard: the resolved candidate must still be the project's own
    // child (a symlinked or oddly named project directory cannot escape root).
    if (path.dirname(candidate) !== projectDir) continue
    if (!candidate.startsWith(rootResolved + path.sep)) continue
    const info = await stat(candidate).catch(() => undefined)
    if (info?.isDirectory() === true) found.push(candidate)
  }
  return found
}

/**
 * Remove the given session directories, deepest artifacts included.
 * @param dirs - absolute directories from {@link findSessionDirs}.
 * @returns the removed paths.
 */
export async function removeSessionDirs(dirs) {
  const removed = []
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: false })
    removed.push(dir)
  }
  return removed
}
