import { afterEach, describe, expect, it } from 'bun:test'
import { createApp } from '../../../server/src/app'
import { openDb } from '../../../server/src/db'
import {
  UNLIMITED,
  currentEdition,
  getLimits,
  resetEdition,
} from '../../../server/src/core/edition'
import { enterpriseEdition, registerEnterpriseEdition } from '../src/index'
import type { IEeModule } from '../src/modules'

afterEach(() => resetEdition())

describe('the Enterprise Edition', () => {
  it('registers with the core and names itself', async () => {
    registerEnterpriseEdition([])
    expect(currentEdition().name).toBe('enterprise')
    const db = await openDb(':memory:')
    const app = await createApp(db, { dataDir: '/tmp/acta-ee-test-name' })
    const health = (await (await app.request('/healthz')).json()) as {
      edition: string
    }
    expect(health.edition).toBe('enterprise')
  })

  it('limits nothing until a module supplies plans', async () => {
    registerEnterpriseEdition([])
    const db = await openDb(':memory:')
    expect(await getLimits(db, 'ws_1')).toEqual({ ...UNLIMITED })
  })

  it('mounts every module, and takes limits from the one that has them', async () => {
    const signup: IEeModule = {
      name: 'signup',
      mountRoutes: (app) => {
        app.get('/api/v1/signup/ping', (c) => c.json({ signup: true }))
      },
    }
    const plans: IEeModule = {
      name: 'plans',
      getLimits: async () => ({ ...UNLIMITED, members: 5 }),
      mountRoutes: (app) => {
        app.get('/api/v1/billing/ping', (c) => c.json({ billing: true }))
      },
    }
    registerEnterpriseEdition([signup, plans])
    const db = await openDb(':memory:')
    const app = await createApp(db, { dataDir: '/tmp/acta-ee-test-mods' })
    expect((await app.request('/api/v1/signup/ping')).status).toBe(200)
    expect((await app.request('/api/v1/billing/ping')).status).toBe(200)
    expect((await getLimits(db, 'ws_1')).members).toBe(5)
  })

  it('refuses two modules that both claim to supply limits', () => {
    const a: IEeModule = {
      name: 'a',
      getLimits: async () => ({ ...UNLIMITED }),
    }
    const b: IEeModule = {
      name: 'b',
      getLimits: async () => ({ ...UNLIMITED }),
    }
    expect(() => enterpriseEdition([a, b])).toThrow('Exactly one may')
  })
})
