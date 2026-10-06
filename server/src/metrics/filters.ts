/**
 * Query filters. M1 supports the path filter only; every query runs over the full history
 * reachable from HEAD (the default scope, so "full history" needs no parameter). Commit-set,
 * time-period and author filters arrive with the query layer and slot into MetricFilters.
 */
export interface MetricFilters {
  /** Substring match on the file path. */
  path?: string
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/** Normalise raw Express query values into MetricFilters; unknown keys are ignored. */
export function parseMetricFilters(query: Record<string, unknown>): MetricFilters {
  const filters: MetricFilters = {}
  const path = firstString(query.path)?.trim()
  if (path) filters.path = path
  return filters
}

/**
 * Build a LIKE pattern for a literal substring match. `%`, `_` and `\` in user input are
 * escaped so that "a_b" cannot match "axb".
 */
export function likePattern(input: string): string {
  const escaped = input.replace(/[\\%_]/g, (char) => `\\${char}`)
  return `%${escaped}%`
}
