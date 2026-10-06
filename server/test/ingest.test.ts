import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createFixtureRepo, createStoredZip, zipFixtureRepo, type FixtureRepo } from './fixtures.js'
import type { SqliteDatabase } from '../src/db.js'

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRATCH_ROOT = join(SERVER_ROOT, 'data', 'test-ingest')

/**
 * The server modules capture their upload/extraction directories when they are imported, so
 * RAT_DATA_DIR is set first and everything below is imported dynamically. Tests therefore
 * never touch the real server/data/uploads or server/data/repos directories.
 */
let dataDir: string
let db: SqliteDatabase
let server: Server
let baseUrl: string
let safeExtractTarget: (root: string, entryPath: string) => string | null

const disposers: Array<() => void> = []

beforeAll(async () => {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  dataDir = mkdtempSync(join(SCRATCH_ROOT, 'data-'))
  process.env.RAT_DATA_DIR = dataDir

  const { openDatabase } = await import('../src/db.js')
  const { createApp } = await import('../src/app.js')
  const ingest = await import('../src/git/ingest.js')
  safeExtractTarget = ingest.safeExtractTarget

  db = openDatabase(':memory:')
  const app = createApp({ db })
  server = await new Promise<Server>((resolveListen) => {
    const instance = app.listen(0, '127.0.0.1', () => resolveListen(instance))
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  db.close()
  for (const dispose of disposers.reverse()) dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

function fixture(): FixtureRepo {
  const repo = createFixtureRepo()
  disposers.push(() => repo.dispose())
  return repo
}

interface RepoSummary {
  id: number
  name: string
  status: string
  error: string | null
  headSha: string | null
  commitCount: number
}

async function postZip(zipPath: string, filename: string): Promise<{ status: number; body: unknown }> {
  const form = new FormData()
  form.append('file', new Blob([readFileSync(zipPath)]), filename)
  const response = await fetch(`${baseUrl}/api/repos`, { method: 'POST', body: form })
  return { status: response.status, body: await response.json() }
}

async function waitForStatus(repoId: number, status: string): Promise<RepoSummary> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/repos`)
    const body = (await response.json()) as { repos: RepoSummary[] }
    const repo = body.repos.find((candidate) => candidate.id === repoId)
    if (repo?.status === status) return repo
    if (repo?.status === 'failed' && status !== 'failed') {
      throw new Error(`ingestion of repo ${repoId} failed: ${repo.error}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`repo ${repoId} never reached status "${status}"`)
}

describe('zip-slip guard', () => {
  const root = '/rat/extraction'

  test('resolves entry names that stay inside the extraction root', () => {
    expect(safeExtractTarget(root, 'src/a.txt')).toBe(resolve(root, 'src/a.txt'))
    expect(safeExtractTarget(root, 'src/deep/b.txt')).toBe(resolve(root, 'src/deep/b.txt'))
    expect(safeExtractTarget(root, 'dir/')).toBe(resolve(root, 'dir'))
  })

  test('refuses entry names that escape the extraction root', () => {
    expect(safeExtractTarget(root, '../evil.txt')).toBeNull()
    expect(safeExtractTarget(root, 'a/../../evil.txt')).toBeNull()
    expect(safeExtractTarget(root, '..\\evil.txt')).toBeNull()
    expect(safeExtractTarget(root, '/etc/passwd')).toBeNull()
    expect(safeExtractTarget(root, 'C:/windows/system32')).toBeNull()
    expect(safeExtractTarget(root, '')).toBeNull()
    // Conservative: any '..' segment is refused, even when it would resolve inside the root.
    expect(safeExtractTarget(root, 'a/../b.txt')).toBeNull()
  })
})

describe('upload pipeline', () => {
  test('a wrapper zip of a repository becomes ready and serves file metrics', async () => {
    const repo = fixture()
    repo.write('src/app.ts', 'one\ntwo\n')
    repo.write('README.md', 'hello\n')
    repo.commit('seed')
    repo.append('src/app.ts', 'three\n')
    repo.commit('extend')

    const zipPath = join(dataDir, 'wrapped.zip')
    zipFixtureRepo(repo, zipPath)
    const { status, body } = await postZip(zipPath, 'wrapped.zip')
    expect(status).toBe(201)
    const created = (body as { repo: RepoSummary }).repo
    expect(created.status).toBe('queued')

    const ready = await waitForStatus(created.id, 'ready')
    expect(ready.commitCount).toBe(2)
    expect(ready.headSha).toBe(repo.head())

    const metricsResponse = await fetch(`${baseUrl}/api/repos/${created.id}/files`)
    expect(metricsResponse.status).toBe(200)
    const metrics = (await metricsResponse.json()) as {
      files: Array<{ path: string; lPlus: number; lMinus: number; delta: number; lambda: number; changes: number }>
      totals: { lPlus: number; lMinus: number; delta: number; lambda: number; paths: number }
      truncated: boolean
    }
    expect(metrics.totals).toEqual({ lPlus: 4, lMinus: 0, delta: 4, lambda: 4, paths: 2 })
    expect(metrics.files[0]).toEqual({
      path: 'src/app.ts',
      lPlus: 3,
      lMinus: 0,
      delta: 3,
      lambda: 3,
      changes: 2,
    })
    expect(metrics.truncated).toBe(false)
  })

  test('an archive without a .git directory fails with a clear error', async () => {
    const zipPath = join(dataDir, 'no-git.zip')
    createStoredZip(zipPath, 'project/readme.txt', 'plain files only\n')
    const { status, body } = await postZip(zipPath, 'no-git.zip')
    expect(status).toBe(201)

    const created = (body as { repo: RepoSummary }).repo
    const failed = await waitForStatus(created.id, 'failed')
    expect(failed.error).toContain('.git')
  })

  test('a zip-slip archive fails and writes nothing outside the extraction root', async () => {
    const zipPath = join(dataDir, 'evil.zip')
    createStoredZip(zipPath, '../evil.txt', 'pwned\n')
    const { status, body } = await postZip(zipPath, 'evil.zip')
    expect(status).toBe(201)

    const created = (body as { repo: RepoSummary }).repo
    const failed = await waitForStatus(created.id, 'failed')
    expect(failed.error).toContain('escapes the extraction directory')
    expect(existsSync(join(dataDir, 'repos', 'evil.txt'))).toBe(false)
    expect(existsSync(join(dataDir, 'evil.txt'))).toBe(false)
  })

  test('a corrupt zip fails ingestion instead of crashing the server', async () => {
    const zipPath = join(dataDir, 'corrupt.zip')
    writeFileSync(zipPath, Buffer.from('PK\x03\x04 this is not really a zip archive'))
    const { status, body } = await postZip(zipPath, 'corrupt.zip')
    expect(status).toBe(201)

    const created = (body as { repo: RepoSummary }).repo
    const failed = await waitForStatus(created.id, 'failed')
    expect(failed.error).toBeTruthy()
  })

  test('uploads without a zip are rejected up front', async () => {
    const empty = await fetch(`${baseUrl}/api/repos`, { method: 'POST', body: new FormData() })
    expect(empty.status).toBe(400)
    await expect(empty.json()).resolves.toMatchObject({ error: 'zip_required' })

    const form = new FormData()
    form.append('file', new Blob(['not a zip'], { type: 'text/plain' }), 'notes.txt')
    const text = await fetch(`${baseUrl}/api/repos`, { method: 'POST', body: form })
    expect(text.status).toBe(400)
    await expect(text.json()).resolves.toMatchObject({ error: 'zip_required' })
  })

  test('the metrics endpoint validates repo ids', async () => {
    const invalid = await fetch(`${baseUrl}/api/repos/not-a-number/files`)
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ error: 'invalid_repo_id' })

    const missing = await fetch(`${baseUrl}/api/repos/99999/files`)
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ error: 'repo_not_found' })
  })
})
