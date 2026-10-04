/**
 * Contract tests for the hand-written client bundle: it must speak the
 * `window.__ModuleLoader__.load` protocol, export `apply`/`inject`, register
 * exactly the two slot entries this feature owns, and ship complete
 * dictionaries. No React rendering is involved.
 *
 * Run: node test/client-bundle.test.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let checks = 0
function ok(label, condition) {
  checks += 1
  assert.ok(condition, `${label} (check ${checks})`)
  console.log(`  ok ${checks} - ${label}`)
}

// --- capture the bundle registration -----------------------------------------
let spec = null
globalThis.window = {
  __ModuleLoader__: {
    load(candidate) {
      spec = candidate
    }
  }
}

const bundlePath = path.join(import.meta.dirname, '..', 'lib', 'client.js')
await import(pathToFileURL(bundlePath).href)

console.log('bundle protocol')
ok('registers through window.__ModuleLoader__.load', spec !== null)
ok('declares the package id', spec.id === 'dsh-session-delete')
ok('provides a factory', typeof spec.factory === 'function')

// --- evaluate the factory with stubbed seed modules --------------------------
const stubRequire = (request) => {
  if (request === 'react') return { useSyncExternalStore: () => null, useEffect: () => {}, useState: () => [null, () => {}] }
  if (request === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
  // An empty primitives surface exercises the no-ui-primitives fallback path.
  if (request === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw new Error(`unexpected require: ${request}`)
}
const exports_ = spec.factory(stubRequire)

console.log('plugin exports')
ok('exports apply()', typeof exports_.apply === 'function')
ok('exports a service list', Array.isArray(exports_.inject))
ok('does not require services that may be absent', !exports_.inject.includes('sessions'))

// --- mount it on a mock client context ---------------------------------------
const registrations = []
const dictionaries = []
const injections = []
const ctx = {
  effect(fn) {
    return fn()
  },
  get() {
    return undefined
  },
  logger: { warn() {} },
  locale: {
    register(namespace, dicts) {
      dictionaries.push([namespace, dicts])
      return () => {}
    }
  },
  slots: {
    inject(name, factory) {
      injections.push(name)
      for (const disposer of factory()) void disposer
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    }
  }
}
exports_.apply(ctx)

console.log('slot registration')
ok('injects two slots', injections.length === 2)
ok('targets the session menu list', injections.includes('sidebar.workspaces.session.menu.item'))
ok('targets the frame overlay', injections.includes('shell.overlay'))
ok('registers two entries', registrations.length === 2)

const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
ok('a menu row is registered', menu !== undefined)
ok('the menu row is namespaced', menu.options.id === 'session-delete')
ok('the menu row sorts after the shipped archive row (400)', menu.options.order === 500)
ok('the menu row declares a render function', typeof menu.component === 'function')
ok('the overlay entry is registered', overlay !== undefined)
ok('the overlay entry is namespaced', overlay.options.id === 'session-delete-confirm')
ok('the overlay entry declares a render function', typeof overlay.component === 'function')
ok(
  'both entries declare the same locale namespace',
  menu.options.locale === overlay.options.locale && menu.options.locale === 'session-delete'
)

console.log('dictionaries')
ok('registers one namespace', dictionaries.length === 1)
const [namespace, dicts] = dictionaries[0]
ok('the namespace is the one the entries declared', namespace === 'session-delete')
ok('ships zh and en', typeof dicts.zh === 'object' && typeof dicts.en === 'object')
const zhKeys = Object.keys(dicts.zh).sort()
const enKeys = Object.keys(dicts.en).sort()
ok('the dictionaries have identical key sets', JSON.stringify(zhKeys) === JSON.stringify(enKeys))
ok('every key is non-empty in both', zhKeys.every((key) => dicts.zh[key] !== '' && dicts.en[key] !== ''))
ok('the menu label exists', typeof dicts.zh['menu.delete'] === 'string' && typeof dicts.en['menu.delete'] === 'string')
ok('the destructive warning exists', typeof dicts.zh['dialog.body'] === 'string' && dicts.zh['dialog.body'].length > 20)

console.log(`\n${checks} checks passed`)
