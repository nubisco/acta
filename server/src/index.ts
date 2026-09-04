import { mkdirSync } from 'node:fs'
import { bunAssetReader, createApp } from './app'
import { openDb } from './db'

const DATA_DIR = process.env.ACTA_DATA_DIR ?? './data'
const PORT = Number(process.env.ACTA_PORT ?? 4460)
const WEB_DIST = process.env.ACTA_WEB_DIST

mkdirSync(DATA_DIR, { recursive: true })

const db = await openDb(`${DATA_DIR}/acta.sqlite`)
const app = await createApp(db, {
  dataDir: DATA_DIR,
  serveAsset: WEB_DIST ? bunAssetReader(WEB_DIST) : undefined,
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
