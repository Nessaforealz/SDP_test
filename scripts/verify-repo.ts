#!/usr/bin/env node
/**
 * Verification gate for the RAT.
 *
 * Every milestone is expected to end with a green run of this one script, so it grows with
 * the project rather than being rewritten. At scaffold time it verifies the prerequisites
 * that all later stages depend on: the Node runtime, git, the SQLite storage layer, the data
 * directory, and the pinned grading repositories.
 *
 * Not yet covered, and added as those stages land:
 *   - synthetic fixture metrics (Stage 1 oracle)
 *   - cJSON/Redis/Git metric comparison against the supplied samples (Stage 6)
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIN_NODE = [18, 19] as const

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

interface PinnedRepo {
  id: string
  name: string
  url: string
  ref: string | null
}

/** Minimal shape of the native module, so a missing install is reported rather than thrown. */
interface SqliteLike {
  prepare(sql: string): { get(): unknown }
  close(): void
}
type SqliteConstructor = new (file: string) => SqliteLike

const checks: CheckResult[] = []

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function check(name: string, run: () => string | void): void {
  try {
    checks.push({ name, ok: true, detail: run() ?? 'ok' })
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

check('node >= 18.19', () => {
  const parts = process.versions.node.split('.').map(Number)
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const supported = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
  assert(supported, `requires >= ${MIN_NODE.join('.')}, running ${process.versions.node}`)
  return `v${process.versions.node}`
})

check('git on PATH', () => execFileSync('git', ['--version'], { encoding: 'utf8' }).trim())

check('storage layer (better-sqlite3)', () => {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as SqliteConstructor
  const db = new Database(':memory:')
  try {
    const row = db.prepare('SELECT sqlite_version() AS version').get() as { version?: unknown }
    assert(typeof row?.version === 'string', 'sqlite_version() returned no version')
    return `sqlite ${String(row.version)} via better-sqlite3`
  } finally {
    db.close()
  }
})

check('data directory writable', () => {
  const dataDir = join(REPO_ROOT, 'data')
  mkdirSync(dataDir, { recursive: true })
  accessSync(dataDir, constants.W_OK)
  return dataDir
})

check('pinned repo manifest', () => {
  const raw = readFileSync(join(REPO_ROOT, 'fixtures', 'pinned-repos.json'), 'utf8')
  const manifest = JSON.parse(raw) as { repos?: PinnedRepo[] }
  const repos = manifest.repos ?? []
  assert(repos.length >= 3, `expected at least 3 grading repositories, found ${repos.length}`)
  const pinned = repos.filter((repo) => repo.ref !== null && repo.ref !== '').length
  const suffix = pinned < repos.length ? ' (sample hashes not supplied yet)' : ''
  return `${repos.length} repos, ${pinned} refs pinned${suffix}`
})

const width = Math.max(...checks.map((item) => item.name.length))
const rule = '-'.repeat(width + 14)

console.log(`\nRAT verification\n${rule}`)
for (const { name, ok, detail } of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(width)}  ${detail}`)
}
console.log(rule)

const failed = checks.filter((item) => !item.ok)
if (failed.length === 0) {
  console.log(`${checks.length}/${checks.length} checks passed.`)
  console.log('Metric correctness not yet covered (synthetic fixtures and pinned samples).\n')
} else {
  console.log(`${failed.length} of ${checks.length} checks failed.\n`)
}

process.exitCode = failed.length === 0 ? 0 : 1
