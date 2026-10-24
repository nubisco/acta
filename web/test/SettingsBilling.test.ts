/**
 * Plan and billing (LA-399), as a workspace admin sees it.
 *
 * Pinned because each failure costs money or trust: an upgrade button that
 * opens nothing, a trial nobody is told ends, an over-limit workspace with no
 * word that the rest is read-only, a Paddle refusal shown in Paddle's words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const billing = vi.fn()
const billingCheckout = vi.fn()
const billingPortal = vi.fn()
const billingSeats = vi.fn()
const openCheckout = vi.fn()

class ApiHttpError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: { error: string }) {
    super(body.error)
    this.status = status
    this.body = body
  }
}

vi.mock('@/api/client', () => ({
  api: { billing, billingCheckout, billingPortal, billingSeats },
  ApiHttpError,
}))
vi.mock('@/composables/usePaddle', () => ({ openCheckout }))
vi.mock('@/composables/useAnalytics', () => ({ trackEvent: vi.fn() }))

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
vi.mock('@nubisco/ui', async (orig) => ({
  ...(await orig<object>()),
  useToast: () => toast,
}))

function state(over: Record<string, unknown> = {}) {
  return {
    plan: 'free',
    state: 'free',
    source: 'free',
    subscription: null,
    limits: {
      spaces: 3,
      members: 5,
      storage_bytes: 1024 ** 3,
      agents: 2,
      rules: 10,
      webhooks: 3,
    },
    usage: {
      spaces: 2,
      members: 1,
      storage_bytes: 0,
      agents: 0,
      rules: 0,
      webhooks: 0,
    },
    team: { members_included: 10, members_max: 50 },
    paddle: { env: 'sandbox', client_token: 'test_x' },
    sales_url: 'https://nubisco.io/contact?product=acta&need=pre-sales',
    ...over,
  }
}

function team(over: Record<string, unknown> = {}) {
  return state({
    plan: 'team',
    state: 'active',
    source: 'subscription',
    subscription: {
      status: 'active',
      billing: 'monthly',
      extra_members: 2,
      current_period_end: '2026-12-01T00:00:00Z',
      ends_at: null,
      grace_until: null,
    },
    limits: {
      spaces: 20,
      members: 12,
      storage_bytes: 50 * 1024 ** 3,
      agents: 20,
      rules: 100,
      webhooks: 25,
    },
    ...over,
  })
}

async function mountPage() {
  vi.resetModules()
  const Page = (await import('@/components/settings/SettingsBilling.vue'))
    .default
  const wrapper = mount(Page)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  billing.mockResolvedValue(state())
})

describe('plan and billing settings', () => {
  it('opens the checkout for the server-made transaction', async () => {
    billingCheckout.mockResolvedValue({
      transaction_id: 'txn_1',
      paddle: { env: 'sandbox', client_token: 'test_x' },
    })
    const wrapper = await mountPage()
    const start = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Start the free trial'))!
    await start.trigger('click')
    await flushPromises()
    expect(billingCheckout).toHaveBeenCalledWith({
      billing: 'monthly',
      extra_members: 0,
    })
    expect(openCheckout).toHaveBeenCalledWith(
      'txn_1',
      { env: 'sandbox', client_token: 'test_x' },
      expect.any(Function),
    )
  })

  it('tells an admin when the trial ends', async () => {
    billing.mockResolvedValue(
      team({
        state: 'trialing',
        subscription: {
          status: 'trialing',
          billing: 'monthly',
          extra_members: 0,
          current_period_end: '2026-11-07T12:00:00Z',
          ends_at: null,
          grace_until: null,
        },
      }),
    )
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('Free trial until')
    expect(wrapper.text()).not.toContain('Start the free trial')
  })

  it('says what is over the limit is read-only, never deleted', async () => {
    billing.mockResolvedValue(state({ usage: { ...state().usage, spaces: 5 } }))
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('5 of 3: over the limit')
  })

  it('shows the plain-words reason when a seat change is refused', async () => {
    billing.mockResolvedValue(team())
    billingSeats.mockRejectedValue(
      new ApiHttpError(409, { error: 'Add them when the trial ends.' }),
    )
    const wrapper = await mountPage()
    const input = wrapper.find('input[type="number"], input')
    await input.setValue('3')
    const save = wrapper.findAll('button').find((b) => b.text() === 'Save')!
    await save.trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('Add them when the trial ends.')
  })
})
