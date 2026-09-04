import { mkdirSync } from 'node:fs'
import { createApp } from './app'
import { openDb } from './db'

const DATA_DIR = process.env.ACTA_DATA_DIR ?? './data'
const PORT = Number(process.env.ACTA_PORT ?? 4460)

mkdirSync(DATA_DIR, { recursive: true })

const db = openDb(`${DATA_DIR}/acta.sqlite`)
const app = createApp(db, {
  dataDir: DATA_DIR,
  webDist: process.env.ACTA_WEB_DIST,
  bootstrap: {
    workspaceName: process.env.ACTA_WORKSPACE ?? 'Nubisco',
    adminEmail: process.env.ACTA_ADMIN_EMAIL,
    adminHandle: process.env.ACTA_ADMIN_HANDLE,
    adminName: process.env.ACTA_ADMIN_NAME,
  },
})

export default {
  port: PORT,
  fetch: app.fetch,
}

console.log(`acta server listening on :${PORT} (data: ${DATA_DIR})`)
