import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Route, Routes, useParams } from 'react-router-dom'
import { getJson, postForm } from './api'

interface MetricFamily {
  scope: string
  detail: string
  state: string
}

interface HealthResponse {
  status: string
  storage: string
}

type RepoStatus = 'queued' | 'cloning' | 'parsing' | 'ready' | 'failed'

interface RepoSummary {
  id: number
  name: string
  source: string | null
  status: RepoStatus
  error: string | null
  headSha: string | null
  commitCount: number
  createdAt: string
  updatedAt: string
}

interface FileMetricRow {
  path: string
  lPlus: number
  lMinus: number
  delta: number
  lambda: number
  changes: number
}

interface FileMetricsTotals {
  lPlus: number
  lMinus: number
  delta: number
  lambda: number
  paths: number
}

interface FileMetricsResponse {
  repo: RepoSummary
  files: FileMetricRow[]
  totals: FileMetricsTotals
  truncated: boolean
}

type ApiState =
  | { status: 'checking'; detail: string }
  | { status: 'ok'; detail: string }
  | { status: 'unreachable'; detail: string }

const METRIC_FAMILIES: MetricFamily[] = [
  {
    scope: 'File',
    detail: 'added lines l+, removed lines l\u2212, growth \u03b4 = l+ \u2212 l\u2212, churn \u03bb = l+ + l\u2212',
    state: 'M1 \u00b7 live',
  },
  { scope: 'Directory', detail: 'the same four, rolled up over every ancestor directory', state: 'next' },
  { scope: 'Repository', detail: 'directory metrics at the root of the commit tree', state: 'planned' },
  { scope: 'Commit set', detail: 'totals, modifications, modification frequency, churn rate', state: 'planned' },
  { scope: 'Author', detail: 'author modifications, author churn, ownership', state: 'planned' },
]

/** Statuses that still change on their own, so the tables keep polling. */
const PENDING_STATUSES: RepoStatus[] = ['queued', 'cloning', 'parsing']
const POLL_MS = 1500

function isPending(status: RepoStatus): boolean {
  return PENDING_STATUSES.includes(status)
}

function ApiStatus() {
  const [state, setState] = useState<ApiState>({ status: 'checking', detail: '' })

  useEffect(() => {
    let cancelled = false
    getJson<HealthResponse>('/health')
      .then((body) => {
        if (!cancelled) setState({ status: 'ok', detail: `storage ${body.storage}` })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (!cancelled) setState({ status: 'unreachable', detail: message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <span className={`api-status api-status--${state.status}`}>
      API {state.status}
      {state.detail ? ` \u00b7 ${state.detail}` : ''}
    </span>
  )
}

function AddRepoForm({ onAdded }: { onAdded: () => void }) {
  const formRef = useRef<HTMLFormElement>(null)
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) {
      setError('Choose a .zip archive of a git repository first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      if (name.trim() !== '') form.append('name', name.trim())
      await postForm<{ repo: RepoSummary }>('/repos', form)
      formRef.current?.reset()
      setName('')
      setFile(null)
      onAdded()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form ref={formRef} className="upload-form" onSubmit={submit}>
      <input
        type="file"
        accept=".zip,application/zip"
        aria-label="Repository zip"
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      <input
        type="text"
        placeholder="Name (optional)"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Uploading\u2026' : 'Add repository'}
      </button>
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  )
}

function RepoTable({ repos }: { repos: RepoSummary[] }) {
  if (repos.length === 0) {
    return <p className="hint">No repositories yet. Upload a zip of a git repository above.</p>
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Repository</th>
            <th>Status</th>
            <th className="num">Commits</th>
            <th>Head</th>
            <th>Updated (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {repos.map((repo) => (
            <tr key={repo.id}>
              <td>
                <Link to={`/repos/${repo.id}`}>{repo.name}</Link>
              </td>
              <td>
                <span className={`status status--${repo.status}`}>{repo.status}</span>
                {repo.error ? <div className="error-text">{repo.error}</div> : null}
              </td>
              <td className="num">{repo.status === 'ready' ? repo.commitCount.toLocaleString() : '\u2014'}</td>
              <td className="mono">{repo.headSha ? repo.headSha.slice(0, 10) : '\u2014'}</td>
              <td className="mono">{repo.updatedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Dashboard() {
  const [repos, setRepos] = useState<RepoSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function load() {
      try {
        const body = await getJson<{ repos: RepoSummary[] }>('/repos')
        if (cancelled) return
        setRepos(body.repos)
        setError(null)
        if (body.repos.some((repo) => isPending(repo.status))) {
          timer = window.setTimeout(load, POLL_MS)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }

    load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [tick])

  return (
    <>
      <p className="lede">
        Upload a zip of a git repository. The server extracts it, parses the full history through
        the git CLI and computes per-file line metrics.
      </p>

      <section className="section">
        <h2>Add repository</h2>
        <AddRepoForm onAdded={() => setTick((value) => value + 1)} />
        {error ? <p className="form-error">Could not load repositories: {error}</p> : null}
      </section>

      <section className="section">
        <h2>Repositories</h2>
        <RepoTable repos={repos} />
      </section>

      <section className="section">
        <h2>Metric families</h2>
        <div className="families">
          {METRIC_FAMILIES.map((family) => (
            <article key={family.scope} className="card">
              <h2>{family.scope}</h2>
              <p>{family.detail}</p>
              <span className="badge">{family.state}</span>
            </article>
          ))}
        </div>
      </section>
    </>
  )
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toLocaleString()}`
}

function FileMetricsTable({ result, loading }: { result: FileMetricsResponse; loading: boolean }) {
  if (result.files.length === 0) {
    return <p className="hint">No files match the current filter.</p>
  }
  return (
    <>
      <div className={`table-wrap${loading ? ' is-loading' : ''}`}>
        <table className="data-table">
          <thead>
            <tr>
              <th>File</th>
              <th className="num">Changes</th>
              <th className="num">l+</th>
              <th className="num">{'l\u2212'}</th>
              <th className="num">{'\u03b4'}</th>
              <th className="num">{'\u03bb'}</th>
            </tr>
          </thead>
          <tbody>
            {result.files.map((file) => (
              <tr key={file.path}>
                <td className="mono">{file.path}</td>
                <td className="num">{file.changes.toLocaleString()}</td>
                <td className="num">{file.lPlus.toLocaleString()}</td>
                <td className="num">{file.lMinus.toLocaleString()}</td>
                <td className="num">{formatSigned(file.delta)}</td>
                <td className="num">{file.lambda.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>{result.totals.paths.toLocaleString()} files</td>
              <td className="num" />
              <td className="num">{result.totals.lPlus.toLocaleString()}</td>
              <td className="num">{result.totals.lMinus.toLocaleString()}</td>
              <td className="num">{formatSigned(result.totals.delta)}</td>
              <td className="num">{result.totals.lambda.toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {result.truncated ? (
        <p className="hint">
          Showing the {result.files.length.toLocaleString()} highest-churn files; the totals cover all{' '}
          {result.totals.paths.toLocaleString()} files.
        </p>
      ) : null}
    </>
  )
}

function RepoView() {
  const params = useParams<{ id: string }>()
  const repoId = Number(params.id)
  const [repo, setRepo] = useState<RepoSummary | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [appliedPath, setAppliedPath] = useState('')
  const [metrics, setMetrics] = useState<FileMetricsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // The repo row (and its status) comes from the same list endpoint the dashboard polls.
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function poll() {
      try {
        const body = await getJson<{ repos: RepoSummary[] }>('/repos')
        if (cancelled) return
        const found = body.repos.find((candidate) => candidate.id === repoId) ?? null
        setRepo(found)
        if (found && isPending(found.status)) {
          timer = window.setTimeout(poll, POLL_MS)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }

    poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [repoId])

  const ready = repo?.status === 'ready'

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setLoading(true)
    getJson<FileMetricsResponse>(`/repos/${repoId}/files`, { path: appliedPath })
      .then((body) => {
        if (!cancelled) {
          setMetrics(body)
          setError(null)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [repoId, ready, appliedPath])

  if (!Number.isInteger(repoId) || repoId <= 0) {
    return <p className="form-error">Invalid repository id.</p>
  }

  return (
    <>
      <p className="lede">
        <Link to="/">{'\u2190'} All repositories</Link>
      </p>
      <h2 className="view-title">{repo ? repo.name : `Repository ${repoId}`}</h2>

      {repo ? (
        <p className="hint">
          <span className={`status status--${repo.status}`}>{repo.status}</span>
          {repo.status === 'ready' && repo.headSha
            ? ` ${repo.commitCount.toLocaleString()} commits parsed \u00b7 head ${repo.headSha.slice(0, 10)}`
            : ''}
        </p>
      ) : null}
      {repo?.error ? <p className="form-error">{repo.error}</p> : null}

      {!ready ? (
        <p className="hint">
          {repo ? 'File metrics appear once the repository is ready.' : 'Loading repository\u2026'}
        </p>
      ) : (
        <>
          <form
            className="filter-form"
            onSubmit={(event) => {
              event.preventDefault()
              setAppliedPath(pathInput.trim())
            }}
          >
            <input
              type="text"
              placeholder="Filter by path substring, e.g. src/"
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
            />
            <button type="submit">Filter</button>
            <button
              type="button"
              disabled={appliedPath === ''}
              onClick={() => {
                setPathInput('')
                setAppliedPath('')
              }}
            >
              Clear
            </button>
            <span className="hint">
              {'Full history from HEAD \u00b7 merges excluded \u00b7 renames attributed to the new path'}
            </span>
          </form>

          {error ? <p className="form-error">{error}</p> : null}
          {loading && !metrics ? <p className="hint">{'Loading metrics\u2026'}</p> : null}
          {metrics ? <FileMetricsTable result={metrics} loading={loading} /> : null}
        </>
      )}
    </>
  )
}

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Repo Analysis Tool</h1>
        <nav>
          <Link to="/">Dashboard</Link>
        </nav>
        <ApiStatus />
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/repos/:id" element={<RepoView />} />
          <Route path="*" element={<p>No such view.</p>} />
        </Routes>
      </main>
    </div>
  )
}
