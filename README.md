# Repo Analysis Tool (RAT)

COMS3011A test project. A web dashboard that measures file, directory, repository, commit-set
and author metrics over the history of a git repository, for multiple repositories, with
filtering and author merging.

## Prerequisites

- **Node.js >= 18.19** — the dependency set is pinned to the last majors that run on Node 18
  (see `engines` in `package.json`).
- **git** on `PATH` — history is read with the git CLI so that rename and binary detection
  follow git's own semantics.

## Setup

```bash
npm install
```

One install at the root installs every workspace (`server` and `web`).

## One-command run

Development — Express API on `:3001` and the Vite dev server on `:5173`, with `/api` proxied
to the API:

```bash
npm run dev
```

Production-style — builds the dashboard, then serves both the API and the static assets from
Express:

```bash
npm run build && npm start
```

Open <http://localhost:5173> in development, or <http://localhost:3001> after a build.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Express API + Vite dev server together |
| `npm run build` | Builds the dashboard into `web/dist` |
| `npm start` | Runs the API, serving `web/dist` when it has been built |
| `npm test` | Server test suite (vitest) |
| `npm run verify:repo` | Verification gate: runtime, git, storage layer, data directory, pinned repos |

## Project layout

```
server/    Express API, SQLite storage, ingestion, metric engine, query layer
web/       React + Vite + ECharts dashboard
scripts/   verification tooling
fixtures/  pinned grading repositories, and later the oracle expectations
```

## Grading repositories

Sample metrics are supplied at a specific commit hash per repository.
`fixtures/pinned-repos.json` holds the URLs; each `ref` is pinned as soon as the official
hash for that repository is known.

| Repository | URL | Pinned ref |
| --- | --- | --- |
| cJSON | <https://github.com/DaveGamble/cJSON.git> | not yet supplied |
| Redis | <https://github.com/redis/redis.git> | not yet supplied |
| Git | <https://github.com/git/git.git> | not yet supplied |

## Pinned Interpretations

<!--
PLACEHOLDER. This section becomes the correctness contract: one numbered entry per resolved
ambiguity in the brief, each stating the ambiguity, the interpretation chosen, the reasoning,
and the test that pins it down. Until it is written out, metric behaviour is provisional.
-->

_Not yet written._
