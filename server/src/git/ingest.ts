import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import multer from 'multer'
import unzipper from 'unzipper'
import type { RepoRow, SqliteDatabase } from '../db.js'
import { parseRepo } from './parse.js'

/** Monorepo root: alongside db.ts and app.ts, three levels up from this file. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** Upload and extraction root; RAT_DATA_DIR relocates it so tests can use a scratch dir. */
const DATA_ROOT = process.env.RAT_DATA_DIR ?? join(REPO_ROOT, 'data')
const UPLOAD_DIR = join(DATA_ROOT, 'uploads')
const REPOS_DIR = join(DATA_ROOT, 'repos')

/** Upload ceiling; the zip of a full repository with history fits comfortably. */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
/** Anti zip-bomb caps: a small archive must not expand without bound. */
const MAX_ENTRIES = 500_000
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024

const ZIP_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'multipart/x-zip',
  'application/octet-stream',
])

export class IngestError extends Error {}

const execFileAsync = promisify(execFile)

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      try {
        mkdirSync(UPLOAD_DIR, { recursive: true })
        callback(null, UPLOAD_DIR)
      } catch (error) {
        callback(error as Error, UPLOAD_DIR)
      }
    },
    filename: (_req, _file, callback) => {
      callback(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.zip`)
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, callback) => {
    const isZip = file.originalname.toLowerCase().endsWith('.zip') || ZIP_MIME_TYPES.has(file.mimetype)
    callback(null, isZip)
  },
})

/** Multer middleware for the single `file` field of POST /api/repos. */
export const uploadZip = upload.single('file')

/**
 * Zip-slip guard. Resolves an archive entry name against the extraction root and returns the
 * absolute target, or null when the entry escapes (absolute path, drive letter, or '..').
 */
export function safeExtractTarget(root: string, entryPath: string): string | null {
  const normalized = entryPath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '') return null
  if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) return null
  if (normalized.split('/').some((segment) => segment === '..')) return null
  const base = resolve(root)
  const target = resolve(base, normalized)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

function isGitRoot(dir: string): boolean {
  const dotGit = join(dir, '.git')
  return existsSync(dotGit) && statSync(dotGit).isDirectory()
}

/**
 * A zip made by "compress this folder" usually wraps the repository in one top-level
 * directory; accept that shape as well as a bare repository at the archive root.
 */
function findRepoRoot(extractionDir: string): string | null {
  if (isGitRoot(extractionDir)) return extractionDir
  const subdirectories = readdirSync(extractionDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX')
  if (subdirectories.length === 1) {
    const inner = join(extractionDir, subdirectories[0]!.name)
    if (isGitRoot(inner)) return inner
  }
  return null
}

async function extractArchive(zipPath: string, destination: string): Promise<void> {
  const archive = await unzipper.Open.file(zipPath)
  let entryCount = 0
  let totalBytes = 0
  for (const entry of archive.files) {
    const entryPath = entry.path.replace(/\\/g, '/')
    if (entryPath === '__MACOSX' || entryPath.startsWith('__MACOSX/')) continue
    if (++entryCount > MAX_ENTRIES) {
      throw new IngestError(`archive has more than ${MAX_ENTRIES} entries`)
    }
    totalBytes += entry.uncompressedSize
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new IngestError('archive expands beyond the 8 GiB safety limit')
    }
    const target = safeExtractTarget(destination, entryPath)
    if (target === null) {
      throw new IngestError(`archive entry escapes the extraction directory: ${entry.path}`)
    }
    if (entry.type === 'Directory') {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    await pipeline(entry.stream(), createWriteStream(target))
  }
}

let queueTail: Promise<void> = Promise.resolve()

/**
 * Ingestions run strictly one at a time: parsing is a synchronous, CPU-heavy pass per
 * repository and SQLite has a single writer, so parallel jobs would only thrash.
 */
export function enqueueIngest(db: SqliteDatabase, repoId: number, repoDir: string, zipPath: string): void {
  queueTail = queueTail.then(() => runIngest(db, repoId, repoDir, zipPath))
}

async function runIngest(db: SqliteDatabase, repoId: number, repoDir: string, zipPath: string): Promise<void> {
  const setStatus = db.prepare(
    "UPDATE repos SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?",
  )
  const setRepoDir = db.prepare("UPDATE repos SET repo_dir = ?, updated_at = datetime('now') WHERE id = ?")
  const setReady = db.prepare(
    "UPDATE repos SET status = 'ready', error = NULL, head_sha = ?, commit_count = ?, updated_at = datetime('now') WHERE id = ?",
  )
  // A failed parse must not leave partial metrics behind to be mistaken for real data.
  const clearCommits = db.prepare('DELETE FROM commits WHERE repo_id = ?')

  try {
    setStatus.run('cloning', null, repoId)
    rmSync(repoDir, { recursive: true, force: true })
    mkdirSync(repoDir, { recursive: true })
    await extractArchive(zipPath, repoDir)

    const root = findRepoRoot(repoDir)
    if (!root) throw new IngestError('archive does not contain a git repository (.git directory missing)')
    if (root !== repoDir) setRepoDir.run(root, repoId)

    await execFileAsync('git', ['-C', root, 'rev-parse', '--git-dir'])

    setStatus.run('parsing', null, repoId)
    const { headSha, commitCount } = await parseRepo(db, repoId, root)
    setReady.run(headSha, commitCount, repoId)
  } catch (error) {
    clearCommits.run(repoId)
    const message = error instanceof Error ? error.message : String(error)
    setStatus.run('failed', message.slice(0, 500), repoId)
  } finally {
    rmSync(zipPath, { force: true })
  }
}

/**
 * Register an uploaded zip as a repository and schedule its ingestion. The returned row is
 * what the client polls; status moves queued -> cloning -> parsing -> ready | failed.
 */
export function createRepoFromZipUpload(
  db: SqliteDatabase,
  file: Express.Multer.File,
  requestedName?: string,
): RepoRow {
  const fromArchive = file.originalname.replace(/\.zip$/i, '').trim()
  const name = requestedName?.trim() || fromArchive || `repo-${Date.now()}`

  const { lastInsertRowid } = db
    .prepare('INSERT INTO repos (name, source, status) VALUES (?, ?, ?)')
    .run(name, file.originalname, 'queued')
  const repoId = Number(lastInsertRowid)

  const repoDir = join(REPOS_DIR, `repo-${repoId}`)
  db.prepare("UPDATE repos SET repo_dir = ?, updated_at = datetime('now') WHERE id = ?").run(repoDir, repoId)

  enqueueIngest(db, repoId, repoDir, file.path)
  return db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as RepoRow
}
