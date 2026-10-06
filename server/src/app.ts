import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { MulterError } from 'multer'
import type { RepoRow, SqliteDatabase } from './db.js'
import { createRepoFromZipUpload, uploadZip } from './git/ingest.js'
import { clampLimit, fileMetrics } from './metrics/engine.js'
import { parseMetricFilters } from './metrics/filters.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WEB_DIST = join(REPO_ROOT, 'web', 'dist')

export interface AppOptions {
  db?: SqliteDatabase
}

/** Public JSON shape of a repository row; the internal extraction path stays server-side. */
function serializeRepo(row: RepoRow) {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    status: row.status,
    error: row.error,
    headSha: row.head_sha,
    commitCount: row.commit_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Build the Express application. Kept separate from process startup so tests can mount it
 * on an ephemeral port.
 */
export function createApp({ db }: AppOptions = {}): Express {
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  // Health is the only endpoint at scaffold time. It also proves the path the Vite dev
  // proxy forwards to.
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'sdp-rat',
      storage: db ? 'ready' : 'unavailable',
      time: new Date().toISOString(),
    })
  })

  // --- Repository ingestion and status ---------------------------------------

  // Multer has already stored the upload on disk when the handler runs; when the file
  // filter rejects a non-zip the request arrives with req.file undefined instead.
  app.post('/api/repos', uploadZip, (req, res) => {
    if (!db) {
      if (req.file) rmSync(req.file.path, { force: true })
      res.status(503).json({ error: 'storage_unavailable' })
      return
    }
    if (!req.file) {
      res.status(400).json({ error: 'zip_required', detail: 'attach one .zip file in the "file" field' })
      return
    }
    const requestedName = typeof req.body?.name === 'string' ? req.body.name : undefined
    const repo = createRepoFromZipUpload(db, req.file, requestedName)
    res.status(201).json({ repo: serializeRepo(repo) })
  })

  app.get('/api/repos', (_req, res) => {
    if (!db) {
      res.status(503).json({ error: 'storage_unavailable' })
      return
    }
    const rows = db.prepare('SELECT * FROM repos ORDER BY id DESC').all() as RepoRow[]
    res.json({ repos: rows.map(serializeRepo) })
  })

  // --- File metrics -----------------------------------------------------------

  app.get('/api/repos/:id/files', (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'storage_unavailable' })
      return
    }
    const repoId = Number(req.params.id)
    if (!Number.isInteger(repoId) || repoId <= 0) {
      res.status(400).json({ error: 'invalid_repo_id' })
      return
    }
    const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as RepoRow | undefined
    if (!repo) {
      res.status(404).json({ error: 'repo_not_found', id: repoId })
      return
    }
    const filters = parseMetricFilters(req.query as Record<string, unknown>)
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : Number.NaN
    const result = fileMetrics(db, repoId, filters, clampLimit(rawLimit))
    res.json({ repo: serializeRepo(repo), filters, ...result })
  })

  // Unknown API routes must return JSON rather than falling through to the dashboard HTML.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', path: req.originalUrl })
  })

  // Production run: serve the built dashboard and let the client router own unknown paths.
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST))
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next()
      res.sendFile(join(WEB_DIST, 'index.html'))
    })
  }

  // Multer reports oversized or malformed uploads by calling next(err); answer in JSON so
  // the client never receives Express's HTML error page.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE'
      res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'zip_too_large' : 'upload_failed',
        detail: error.code,
      })
      return
    }
    console.error('unhandled request error:', error)
    res.status(500).json({ error: 'internal_error' })
  })

  return app
}
