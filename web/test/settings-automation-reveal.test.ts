/**
 * The one-time secret on the Automation page.
 *
 * It is shown once, so two things matter: it appears where the user is (a
 * modal, not a banner above the fold) and stays until dismissed, and the Copy
 * button says what happened instead of failing silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const ingestTokens = vi.fn(async () => ({ tokens: [] }))
const webhooks = vi.fn(async () => ({ webhooks: [] }))
const rules = vi.fn(async () => ({ rules: [] }))
const connections = vi.fn(async () => ({ connections: [] }))

vi.mock('@/api/client', () => ({
  api: { ingestTokens, webhooks, rules, connections },
  auth: {},
  getWorkspaceSlug: () => 'nubisco',
  newOpId: () => 'op',
}))

const TokenStub = defineComponent({
  props: { open: Boolean, kind: String },
  emits: ['close', 'created'],
  setup:
    (props, { emit }) =>
    () =>
      h('button', {
        class: 'stub-token',
        'data-kind': props.kind,
        onClick: () => emit('created', 'tok_secret'),
      }),
})
const Inert = defineComponent({ render: () => h('div') })

async function mountPage() {
  vi.resetModules()
  const Page = (await import('@/components/settings/SettingsAutomation.vue'))
    .default
  const wrapper = mount(Page, {
    attachTo: document.body,
    global: {
      stubs: {
        NewTokenModal: TokenStub,
        NewWebhookModal: Inert,
        NewConnectionModal: Inert,
        RuleEditModal: Inert,
      },
    },
  })
  await flushPromises()
  return wrapper
}

const copyButton = () =>
  document.body.querySelector<HTMLButtonElement>('[data-copy="Token"]')

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('a new agent token', () => {
  it('opens a modal that stays until dismissed, and refreshes the list', async () => {
    const wrapper = await mountPage()
    const before = webhooks.mock.calls.length

    await wrapper.find('.stub-token[data-kind="agent"]').trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('It is shown once')
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(webhooks.mock.calls.length).toBe(before + 1)

    // Clicking the overlay must not lose a secret that cannot be shown again.
    document.body
      .querySelector<HTMLElement>('.nb-modal__overlay, [class*="overlay"]')
      ?.click()
    await flushPromises()
    expect(copyButton()).not.toBeNull()

    const done = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Done',
    )
    done?.click()
    await flushPromises()
    expect(copyButton()).toBeNull()
  })
})

describe('the Copy button', () => {
  it('says Copied for about two seconds, then reverts', async () => {
    const wrapper = await mountPage()
    await wrapper.find('.stub-token[data-kind="agent"]').trigger('click')
    await flushPromises()

    copyButton()?.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('tok_secret')
    expect(copyButton()?.textContent).toContain('Copied')

    vi.advanceTimersByTime(2000)
    await flushPromises()
    expect(copyButton()?.textContent?.trim()).toBe('Copy')
  })

  it('says Copy failed when the clipboard refuses', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const wrapper = await mountPage()
    await wrapper.find('.stub-token[data-kind="agent"]').trigger('click')
    await flushPromises()

    copyButton()?.click()
    await flushPromises()
    expect(copyButton()?.textContent).toContain('Copy failed')
  })
})
