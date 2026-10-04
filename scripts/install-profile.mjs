/**
 * Point one DSH profile at this plugin: add the link dependency and the
 * bundle entry, leaving every other field (and field order) untouched.
 *
 * Usage:
 *   node scripts/install-profile.mjs [profileDir] [pluginDir]
 *   node scripts/install-profile.mjs --revert [profileDir]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'dsh-session-delete'
const args = process.argv.slice(2)
const revert = args.includes('--revert')
const positional = args.filter((value) => !value.startsWith('--'))
const profileDir = positional[0] ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const pluginDir = positional[1] ?? path.resolve(import.meta.dirname, '..')

const pkgPath = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

if (revert) {
  if (pkg.dependencies !== undefined) delete pkg.dependencies[PLUGIN]
  const bundles = pkg.dsh?.profile?.bundles
  if (Array.isArray(bundles)) pkg.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN)
} else {
  pkg.dependencies = pkg.dependencies ?? {}
  pkg.dependencies[PLUGIN] = 'link:' + pluginDir.replace(/\\/g, '/')
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (!bundles.includes(PLUGIN)) bundles.push(PLUGIN)
  pkg.dsh.profile.bundles = bundles
}

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(`${revert ? 'removed' : 'wired'} ${PLUGIN} in ${pkgPath}`)
console.log(JSON.stringify({ dependencies: pkg.dependencies?.[PLUGIN], bundles: pkg.dsh?.profile?.bundles }, null, 2))
