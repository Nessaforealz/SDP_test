import { useEffect, useState } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import { getJson } from './api.js'

const METRIC_FAMILIES = [
  { scope: 'File', detail: 'added lines, removed lines, growth, churn' },
  { scope: 'Directory', detail: 'the same four, rolled up over immediate children' },
  { scope: 'Repository', detail: 'directory metrics at the root of the commit tree' },
  { scope: 'Commit set', detail: 'totals, modifications, modification frequency, churn rate' },
  { scope: 'Author', detail: 'author modifications, author churn, ownership' },
]

function ApiStatus() {
  const [state, setState] = useState({ status: 'checking', detail: '' })

  useEffect(() => {
    let cancelled = false
    getJson('/health')
      .then((body) => {
        if (!cancelled) setState({ status: 'ok', detail: `storage ${body.storage}` })
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'unreachable', detail: error.message })
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

function Dashboard() {
  return (
    <>
      <p className="lede">
        Scaffold stage. Routing, the Vite proxy and the SQLite storage layer are wired up.
        Ingestion, the metric engine and filtering land next, in that order.
      </p>

      <section className="families">
        {METRIC_FAMILIES.map((family) => (
          <article key={family.scope} className="card">
            <h2>{family.scope}</h2>
            <p>{family.detail}</p>
            <span className="badge">planned</span>
          </article>
        ))}
      </section>
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
          <Route path="*" element={<p>No such view.</p>} />
        </Routes>
      </main>
    </div>
  )
}
