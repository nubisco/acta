/**
 * The door.
 *
 * Where a provider is configured it IS the identity, so this page hands
 * straight over instead of asking for an email address first. The two escapes
 * are what stop that becoming a trap, and they are the reason for the tests:
 * a failed sign-in must not bounce straight back out (an infinite round trip
 * between here and the provider), and there has to be a way to the one-time
 * code form when the provider itself is down. That happened, and the form was
 * the only reason it was recoverable.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const query = { value: {} as Record<string, unknown> }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => ({
    get query() {
      return query.value
    },
  }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({ loadMe: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/api/client', () => ({
  auth: { requestOtp: vi.fn(), verifyOtp: vi.fn() },
  ApiHttpError: class extends Error {},
}))

import LoginView from '@/views/LoginView.vue'

const assign = vi.fn()
let ssoConfigured = true
let otpConfigured = false

beforeEach(() => {
  query.value = {}
  assign.mockClear()
  ssoConfigured = true
  // The hosted shape: a provider owns sign-in and codes are off behind it.
  otpConfigured = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      json: async () => ({
        sso: ssoConfigured,
        otp: otpConfigured,
        sso_label: 'Acme SSO',
      }),
    })),
  )
  // location.href is how the handover happens; capture it rather than navigate.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      set href(v: string) {
        assign(v)
      },
      get href() {
        return ''
      },
    },
  })
})

const render = async () => {
  const view = mount(LoginView, { global: { stubs: { teleport: true } } })
  await flushPromises()
  return view
}

describe('LoginView', () => {
  it('hands straight over to the provider', async () => {
    const view = await render()
    expect(assign).toHaveBeenCalledWith('/api/v1/auth/sso/start')
    // And says so, rather than flashing a form on the way out.
    expect(view.text()).toContain('Taking you to Acme SSO')
    expect(view.find('#login-email-form').exists()).toBe(false)
  })

  // Bouncing out again on a failure is an infinite round trip.
  it('stops and shows the page when sign-in failed', async () => {
    otpConfigured = true
    query.value = { error: 'sso_token' }
    const view = await render()
    expect(assign).not.toHaveBeenCalled()
    expect(view.text()).toContain('Single sign-on failed')
    expect(view.find('#login-email-form').exists()).toBe(true)
  })

  // Only where the server still offers them. A ?code=1 that rendered a form
  // posting to an endpoint returning 404 would be a door painted on a wall.
  it('ignores a request for codes when the server has them off', async () => {
    query.value = { code: '1' }
    const view = await render()
    expect(assign).toHaveBeenCalledWith('/api/v1/auth/sso/start')
    expect(view.find('#login-email-form').exists()).toBe(false)
  })

  // The way back in when an instance deliberately keeps both.
  it('offers the code form on request when the server allows it', async () => {
    otpConfigured = true
    query.value = { code: '1' }
    const view = await render()
    expect(assign).not.toHaveBeenCalled()
    expect(view.find('#login-email-form').exists()).toBe(true)
  })

  // A failed sign-in with codes off has nothing to fall back to, so it says
  // what happened and offers the provider again rather than a dead form.
  it('shows no code form on failure when codes are off', async () => {
    query.value = { error: 'sso_token' }
    const view = await render()
    expect(assign).not.toHaveBeenCalled()
    expect(view.text()).toContain('Single sign-on failed')
    expect(view.find('#login-email-form').exists()).toBe(false)
    // The provider's name comes from the server. It used to be hardcoded,
    // which told every self-hosted instance to sign in with a product its
    // users have never heard of.
    expect(view.text()).toContain('Sign in with Acme SSO')
  })

  // A self-hosted instance with no provider: codes are the only way in.
  it('never redirects when no provider is configured', async () => {
    ssoConfigured = false
    otpConfigured = true
    const view = await render()
    expect(assign).not.toHaveBeenCalled()
    expect(view.find('#login-email-form').exists()).toBe(true)
  })
})
