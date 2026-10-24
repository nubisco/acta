/**
 * Signup and onboarding (LA-398). The page decides from the server who is
 * signing up, so it never takes an email from a field, and only the first
 * step, the workspace, is required.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, ref } from 'vue'

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

const signupEnabled = ref(true)
const enterWorkspace = vi.fn(async () => true)
vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    loadAuthConfig: vi.fn(async () => undefined),
    signupEnabled: computed(() => signupEnabled.value),
    forgetWorkspaces: vi.fn(),
    loadMe: vi.fn(async () => true),
    enterWorkspace,
  }),
}))

const signupState = vi.fn()
const createWorkspace = vi.fn()
const spaceWrite = vi.fn()
const inviteMember = vi.fn()
const itemWrite = vi.fn()
vi.mock('@/api/client', () => ({
  auth: {
    signupState: () => signupState(),
    signupSlug: vi.fn(async () => ({
      slug: 'acme',
      available: true,
      problem: null,
    })),
    createWorkspace: (b: unknown) => createWorkspace(b),
    signInUrl: (to: string) => `/api/v1/auth/sso/start?to=${to}`,
  },
  api: {
    spaceWrite: (ops: unknown) => spaceWrite(ops),
    inviteMember: (i: unknown) => inviteMember(i),
    itemWrite: (ops: unknown, s: string) => itemWrite(ops, s),
  },
  newOpId: () => 'op',
  setWorkspaceSlug: vi.fn(),
}))

const track = vi.fn()
vi.mock('@/composables/useAnalytics', () => ({
  trackEvent: (name: string, props?: unknown) => track(name, props),
}))

import SignupView from '@/views/SignupView.vue'

const pending = {
  identity: { email: 'ana@example.com', name: 'Ana', source: 'pending' },
  owned: 0,
  cap: 1,
  can_create: true,
  terms: null,
  sales_url: 'https://nubisco.io/contact',
}

beforeEach(() => {
  signupEnabled.value = true
  for (const f of [
    push,
    enterWorkspace,
    signupState,
    createWorkspace,
    spaceWrite,
    inviteMember,
    itemWrite,
    track,
  ])
    f.mockClear()
})

const render = async () => {
  const view = mount(SignupView, { global: { stubs: { teleport: true } } })
  await flushPromises()
  return view
}

async function fill(view: ReturnType<typeof mount>, id: string, value: string) {
  await view.find(`#${id}`).setValue(value)
}

describe('SignupView', () => {
  it('says so on an instance without signup, and asks the server nothing', async () => {
    signupEnabled.value = false
    const view = await render()
    expect(view.text()).toContain('Workspaces are created by an admin here')
    expect(signupState).not.toHaveBeenCalled()
  })

  it('asks a visitor with no identity to sign in first', async () => {
    signupState.mockResolvedValue({ ...pending, identity: null })
    const view = await render()
    expect(view.text()).toContain('Sign in first')
  })

  it('points at sales when the account already has its workspace', async () => {
    signupState.mockResolvedValue({ ...pending, can_create: false, owned: 1 })
    const view = await render()
    expect(view.text()).toContain('You already have a workspace')
    expect(view.text()).toContain('Contact sales')
  })

  it('creates the workspace, then walks the optional steps', async () => {
    signupState.mockResolvedValue(pending)
    createWorkspace.mockResolvedValue({ workspace_id: 'ws_1', slug: 'acme' })
    spaceWrite.mockResolvedValue({ results: [{ ok: true }] })
    inviteMember.mockResolvedValue({ emailed: true })
    itemWrite.mockResolvedValue({ results: [{ ok: true }] })
    const view = await render()
    expect(track).toHaveBeenCalledWith('Signup Started', undefined)
    expect(view.text()).toContain('ana@example.com')

    await fill(view, 'signup-name', 'Acme')
    await view.find('#signup-workspace').trigger('submit')
    await flushPromises()
    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme' }),
    )
    expect(enterWorkspace).toHaveBeenCalledWith('acme')
    expect(track).toHaveBeenCalledWith('Workspace Created', undefined)
    expect(track).toHaveBeenCalledWith('Signup Completed', undefined)

    await fill(view, 'signup-space-name', 'Product Roadmap')
    await view.find('#signup-space').trigger('submit')
    await flushPromises()
    expect(spaceWrite).toHaveBeenCalledWith([
      expect.objectContaining({ key: 'PR', template: 'kanban6' }),
    ])
    expect(track).toHaveBeenCalledWith('First Space', { template: 'kanban6' })

    await fill(view, 'signup-invite-email-0', 'ivan@example.com')
    await view.find('#signup-invite').trigger('submit')
    await flushPromises()
    expect(inviteMember).toHaveBeenCalledWith({
      email: 'ivan@example.com',
      name: 'ivan',
      role: 'member',
    })
    expect(track).toHaveBeenCalledWith('First Invite', { count: 1 })

    await fill(view, 'signup-card-title', 'Plan the launch')
    await view.find('#signup-card').trigger('submit')
    await flushPromises()
    expect(itemWrite).toHaveBeenCalledWith(
      [expect.objectContaining({ list: 'To Do', title: 'Plan the launch' })],
      'PR',
    )
    expect(push).toHaveBeenCalledWith('/acme/s/PR')
  })

  it('needs the terms ticked where the deployment has them', async () => {
    signupState.mockResolvedValue({
      ...pending,
      terms: {
        version: '2026-11',
        terms_url: 'https://nubisco.io/terms',
        privacy_url: null,
      },
    })
    const view = await render()
    const submit = view.find('#signup-workspace button[type="submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    expect(view.find('a[href="https://nubisco.io/terms"]').exists()).toBe(true)
  })
})
