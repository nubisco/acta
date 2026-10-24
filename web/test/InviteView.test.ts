/**
 * Accepting an invitation (LA-397).
 *
 * The link opens a page and accepting is a button, never the page load: mail
 * scanners fetch every link in a message, and an invitation that accepted
 * itself when one looked would prove nothing about who owns the address.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { token: 'acta_inv_abc' } }),
}))

const invitationPreview = vi.fn()
const acceptInvitation = vi.fn()
vi.mock('@/api/client', () => ({
  api: {
    invitationPreview: (t: string) => invitationPreview(t),
    acceptInvitation: (t: string) => acceptInvitation(t),
  },
  ApiHttpError: class extends Error {
    status = 0
  },
}))

import InviteView from '@/views/InviteView.vue'

const assign = vi.fn()

const pending = {
  workspace: 'Acme',
  inviter: 'Ana',
  email: 'ivan@example.com',
  role: 'member',
  status: 'pending',
  expires_at: Date.now() + 1000,
  proof: 'provider',
}

beforeEach(() => {
  invitationPreview.mockReset()
  acceptInvitation.mockReset()
  assign.mockClear()
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
  const view = mount(InviteView, { global: { stubs: { teleport: true } } })
  await flushPromises()
  return view
}

describe('InviteView', () => {
  it('says who invited whom, and accepts nothing on load', async () => {
    invitationPreview.mockResolvedValue(pending)
    const view = await render()
    expect(invitationPreview).toHaveBeenCalledWith('acta_inv_abc')
    expect(view.text()).toContain('Join Acme')
    expect(view.text()).toContain('ivan@example.com')
    expect(view.text()).toContain('sign in as that address')
    expect(acceptInvitation).not.toHaveBeenCalled()
  })

  it('accepts on the button and goes where the server says', async () => {
    invitationPreview.mockResolvedValue(pending)
    acceptInvitation.mockResolvedValue({ next: '/api/v1/auth/sso/start' })
    const view = await render()
    const button = view
      .findAll('button')
      .find((b) => b.text().includes('Accept and join'))!
    await button.trigger('click')
    await flushPromises()
    expect(acceptInvitation).toHaveBeenCalledWith('acta_inv_abc')
    expect(assign).toHaveBeenCalledWith('/api/v1/auth/sso/start')
  })

  it('explains a dead link instead of offering to accept it', async () => {
    invitationPreview.mockResolvedValue({ ...pending, status: 'revoked' })
    const view = await render()
    expect(view.text()).toContain('withdrawn')
    expect(view.text()).not.toContain('Accept and join')
  })
})
