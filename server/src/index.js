import { createApp } from './app.js'
import { openDatabase } from './db.js'

const PORT = Number(process.env.PORT ?? 3001)

const db = openDatabase()
const server = createApp({ db }).listen(PORT, () => {
  console.log(`[rat] API listening on http://localhost:${PORT}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close()
      process.exit(0)
    })
  })
}
