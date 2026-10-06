import type { SqliteDatabase } from '../db.js'
import { likePattern, type MetricFilters } from './filters.js'

/**
 * File metrics over the full history of one repository.
 *
 *   l+  = lines added        (sum of numstat additions for the path)
 *   l-  = lines removed      (sum of numstat deletions for the path)
 *   δ   = l+ - l-            (growth)
 *   λ   = l+ + l-            (churn)
 *
 * Renames are attributed to the new path (git's numstat deltas for a rename are the edit
 * deltas only, so a pure rename contributes 0/0). Binary files carry no line counts and
 * contribute nothing to the sums.
 */
export interface FileMetricRow {
  path: string
  lPlus: number
  lMinus: number
  delta: number
  lambda: number
  /** Number of (commit, file) change records for the path. */
  changes: number
}

export interface FileMetricsTotals {
  lPlus: number
  lMinus: number
  delta: number
  lambda: number
  /** Distinct file paths matched by the filters. */
  paths: number
}

export interface FileMetricsResult {
  files: FileMetricRow[]
  totals: FileMetricsTotals
  /** True when the path count exceeds the returned rows. */
  truncated: boolean
}

export const DEFAULT_FILE_LIMIT = 500
const MAX_FILE_LIMIT = 5000

interface FileMetricsSqlRow {
  path: string
  l_plus: number
  l_minus: number
  changes: number
}

interface TotalsSqlRow {
  l_plus: number
  l_minus: number
  paths: number
}

export function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return DEFAULT_FILE_LIMIT
  return Math.min(Math.trunc(limit!), MAX_FILE_LIMIT)
}

export function fileMetrics(
  db: SqliteDatabase,
  repoId: number,
  filters: MetricFilters,
  limit: number = DEFAULT_FILE_LIMIT,
): FileMetricsResult {
  const where = ['c.repo_id = @repoId']
  const params: Record<string, unknown> = { repoId }
  if (filters.path) {
    where.push("fc.path LIKE @path ESCAPE '\\'")
    params.path = likePattern(filters.path)
  }
  const clause = where.join(' AND ')

  const files = db
    .prepare(
      `SELECT fc.path AS path,
              SUM(fc.added)   AS l_plus,
              SUM(fc.deleted) AS l_minus,
              COUNT(*)        AS changes
       FROM file_changes fc
       JOIN commits c ON c.id = fc.commit_id
       WHERE ${clause}
       GROUP BY fc.path
       ORDER BY (SUM(fc.added) + SUM(fc.deleted)) DESC, fc.path ASC
       LIMIT @limit`,
    )
    .all({ ...params, limit }) as FileMetricsSqlRow[]

  const totalsRow = db
    .prepare(
      `SELECT COALESCE(SUM(fc.added), 0)    AS l_plus,
              COALESCE(SUM(fc.deleted), 0)  AS l_minus,
              COUNT(DISTINCT fc.path)       AS paths
       FROM file_changes fc
       JOIN commits c ON c.id = fc.commit_id
       WHERE ${clause}`,
    )
    .get(params) as TotalsSqlRow

  const rows: FileMetricRow[] = files.map((row) => {
    const lPlus = Number(row.l_plus)
    const lMinus = Number(row.l_minus)
    return {
      path: row.path,
      lPlus,
      lMinus,
      delta: lPlus - lMinus,
      lambda: lPlus + lMinus,
      changes: Number(row.changes),
    }
  })

  const totalLPlus = Number(totalsRow.l_plus)
  const totalLMinus = Number(totalsRow.l_minus)

  return {
    files: rows,
    totals: {
      lPlus: totalLPlus,
      lMinus: totalLMinus,
      delta: totalLPlus - totalLMinus,
      lambda: totalLPlus + totalLMinus,
      paths: Number(totalsRow.paths),
    },
    truncated: Number(totalsRow.paths) > rows.length,
  }
}
