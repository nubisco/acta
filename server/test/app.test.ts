import { describe, expect, it } from 'bun:test'
import { createApp } from '../src/app'
import { openDb } from '../src/db'

describe('server skeleton', () => {
  it('boots, migrates, and serves /healthz', async () => {
    const db = await openDb(':memory:')
    const app = await createApp(db, { dataDir: '/tmp/acta-test-app' })
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('acta')
  })

  it('has the core tables after migration', async () => {
    const db = await openDb(':memory:')
    const tables = (
      await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name",
      )
    ).map((r) => r.name)
    for (const t of [
      'workspace',
      'actor',
      'space',
      'list',
      'item',
      'document',
      'doc_version',
      'event',
      'op_log',
      'webhook',
      'rule',
    ]) {
      expect(tables).toContain(t)
    }
  })

  // With no provider configured, codes ARE the way in. This is the
  // self-hosted case, and the reason the code path stays rather than being
  // deleted along with the form.
  it('keeps one-time codes when no provider is configured', async () => {
    const db = await openDb(':memory:')
    const app = await createApp(db, {
      bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
      dataDir: '/tmp/acta-test-nosso',
    })
    const res = await app.request('/api/v1/auth/config')
    expect(await res.json()).toEqual({ sso: false, otp: true })

    const otp = await app.request('/api/v1/auth/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'jose@nubisco.io' }),
    })
    expect(otp.status).toBe(200)
  })
})
