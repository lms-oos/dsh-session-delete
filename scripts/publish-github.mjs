/**
 * Publish this plugin to GitHub over the REST API.
 *
 * Written for a machine without git or gh: one commit is assembled from
 * blobs → tree → commit → ref, so the repository gets a single clean history
 * instead of one commit per uploaded file.
 *
 * Two GitHub behaviours are handled explicitly:
 * - an empty repository has no git database, so blob/tree writes answer
 *   `409 Git Repository is empty` until one commit exists — the first file is
 *   therefore seeded through the contents API;
 * - a non-empty repository is never overwritten unless `--update` is passed,
 *   in which case the new commit is parented on the current `main`.
 *
 * The token is read from a local file (excluded by .gitignore) and is never
 * printed, never passed on a command line, and never written into the repo.
 *
 * Usage:
 *   node scripts/publish-github.mjs --dry-run
 *   node scripts/publish-github.mjs --repo dsh-session-delete --description "..."
 *   node scripts/publish-github.mjs --update
 *
 * Flags: --token <path>  --repo <name>  --description <text>  --private
 *        --dry-run  --update
 */
import fs from 'node:fs'
import path from 'node:path'

const API = 'https://api.github.com'
const ROOT = path.resolve(import.meta.dirname, '..')

/** Exactly what gets published (no tmp dirs, no node_modules, no token file). */
const FILES = [
  '.gitignore',
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'package.json',
  'lib/client.js',
  'lib/delete-core.js',
  'lib/index.js',
  'scripts/install-profile.mjs',
  'scripts/publish-github.mjs',
  'test/client-bundle.test.mjs',
  'test/delete-core.test.mjs',
  'test/host-route.test.mjs'
]

const opts = {
  token: process.env.GITHUB_TOKEN_FILE ?? path.join(ROOT, '.github-token.txt'),
  repo: 'dsh-session-delete',
  description: 'DSH plugin: delete a conversation from the DeepSeek Harness sidebar.',
  private: false,
  dryRun: false,
  update: false
}
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index]
  if (flag === '--token') opts.token = argv[++index]
  else if (flag === '--repo') opts.repo = argv[++index]
  else if (flag === '--description') opts.description = argv[++index]
  else if (flag === '--private') opts.private = true
  else if (flag === '--dry-run') opts.dryRun = true
  else if (flag === '--update') opts.update = true
  else throw new Error(`unknown argument: ${flag}`)
}

/**
 * Read the access token, refusing anything that does not look like one.
 * @param tokenPath - absolute path of the token file.
 * @returns the trimmed token.
 */
function readToken(tokenPath) {
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`token file not found: ${tokenPath}\ncreate it with: Set-Content -Path '${tokenPath}' -Value '<your token>' -NoNewline -Encoding ascii`)
  }
  const token = fs.readFileSync(tokenPath, 'utf8').trim()
  if (token === '') throw new Error(`token file is empty: ${tokenPath}`)
  if (/\s/.test(token)) throw new Error('token contains whitespace — make sure the file holds only the token')
  return token
}

/**
 * One GitHub API call.
 * @returns the parsed JSON body.
 */
async function api(token, method, endpoint, body) {
  const response = await fetch(API + endpoint, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-session-delete-publish',
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const message = parsed?.message ?? text.slice(0, 200)
    const error = new Error(`${method} ${endpoint} -> ${response.status} ${message}`)
    error.status = response.status
    error.detail = parsed
    throw error
  }
  return parsed
}

const token = readToken(opts.token)
const account = await api(token, 'GET', '/user')
const owner = account.login
console.log(`account      : ${owner}${account.name === undefined ? '' : ` (${account.name})`}`)
console.log(`repository   : ${owner}/${opts.repo} (${opts.private ? 'private' : 'public'})`)

const plan = []
for (const relative of FILES) {
  const absolute = path.join(ROOT, relative)
  if (!fs.existsSync(absolute)) throw new Error(`missing file: ${relative}`)
  plan.push({ relative, absolute, bytes: fs.statSync(absolute).size })
}
console.log(`files        : ${plan.length} (${plan.reduce((total, item) => total + item.bytes, 0)} bytes)`)
for (const item of plan) console.log(`  ${String(item.bytes).padStart(7)}  ${item.relative}`)

if (opts.dryRun) {
  console.log('\ndry run: nothing was created or uploaded')
  process.exit(0)
}

// --- create the repository, or adopt the existing one ------------------------
try {
  await api(token, 'POST', '/user/repos', {
    name: opts.repo,
    description: opts.description,
    private: opts.private,
    auto_init: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false
  })
  console.log(`\ncreated repository ${owner}/${opts.repo}`)
} catch (error) {
  if (error.status !== 422) throw error
  const existing = await api(token, 'GET', `/repos/${owner}/${opts.repo}`)
  if ((existing.size ?? 0) > 0 && !opts.update) {
    throw new Error(`repository ${owner}/${opts.repo} already exists with content (${existing.size} KB) — pass --update to push a new commit onto it`)
  }
  console.log(`\nrepository ${owner}/${opts.repo} already exists — ${opts.update ? 'updating' : 'filling the empty repository'}`)
}

/**
 * The commit this push builds on.
 *
 * A repository with no `main` yet has no git database to hang blobs on (GitHub
 * answers 409 "Git Repository is empty"), so its first commit is seeded through
 * the contents API; an existing `main` simply supplies its head commit.
 * @returns the parent commit sha.
 */
async function resolveParent() {
  try {
    const ref = await api(token, 'GET', `/repos/${owner}/${opts.repo}/git/ref/heads/main`)
    console.log(`  building on main at ${String(ref.object.sha).slice(0, 7)}`)
    return ref.object.sha
  } catch (error) {
    if (error.status !== 404 && error.status !== 409) throw error
  }
  const first = plan[0]
  const seeded = await api(token, 'PUT', `/repos/${owner}/${opts.repo}/contents/${first.relative}`, {
    message: `chore: add ${first.relative}`,
    content: fs.readFileSync(first.absolute).toString('base64')
  })
  console.log(`  seeded main with ${first.relative}`)
  return seeded.commit.sha
}
const parent = await resolveParent()

// --- blobs → tree → commit → ref ---------------------------------------------
const entries = []
for (const item of plan) {
  const blob = await api(token, 'POST', `/repos/${owner}/${opts.repo}/git/blobs`, {
    content: fs.readFileSync(item.absolute).toString('base64'),
    encoding: 'base64'
  })
  entries.push({ path: item.relative.split(path.sep).join('/'), mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  uploaded ${item.relative}`)
}

const message = opts.update
  ? 'Update published files\n\nRegenerated from the working tree.'
  : 'Add dsh-session-delete: delete a conversation from the DSH sidebar\n\nHost route + client menu row, 70 self-checks, MIT.'
const tree = await api(token, 'POST', `/repos/${owner}/${opts.repo}/git/trees`, { tree: entries })
const commit = await api(token, 'POST', `/repos/${owner}/${opts.repo}/git/commits`, {
  message,
  tree: tree.sha,
  parents: [parent]
})
try {
  await api(token, 'POST', `/repos/${owner}/${opts.repo}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha })
} catch (error) {
  if (error.status !== 422) throw error
  await api(token, 'PATCH', `/repos/${owner}/${opts.repo}/git/refs/heads/main`, { sha: commit.sha })
}
await api(token, 'PATCH', `/repos/${owner}/${opts.repo}`, { default_branch: 'main' }).catch(() => undefined)

console.log(`\ncommit ${commit.sha.slice(0, 10)} on main`)
console.log(`https://github.com/${owner}/${opts.repo}`)
console.log('\n(delete the local token file now — it is no longer needed)')
