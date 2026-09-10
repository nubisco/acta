/**
 * The welcome, and the one thing it must never do: ask twice.
 *
 * Onspaceing is recorded on the actor rather than in the browser, so these
 * assert the call is made even when the person changed nothing, and that a
 * failed picture upload does not trap them behind a modal they cannot close.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const uploadAvatar = vi.fn(async () => ({ ok: true, avatar_url: '/a.png' }))
const markOnspaceed = vi.fn(async () => ({ ok: true }))

vi.mock('@/api/client', () => ({
  api: { uploadAvatar: (...a: unknown[]) => uploadAvatar(...(a as [])) },
  auth: { markOnspaceed: () => markOnspaceed() },
  // humanise() narrows on this, so a mock without it turns every error path
  // into a different error than the one under test.
  ApiHttpError: class ApiHttpError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message)
    }
  },
}))

const refresh = vi.fn(async () => undefined)
vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({ refresh, overview: { value: { actors: [] } } }),
}))

const setTheme = vi.fn()
vi.mock('@nubisco/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useTheme: () => ({
      theme: { value: 'system' },
      resolved: { value: 'dark' },
      setTheme,
    }),
  }
})

import WelcomeModal from '@/components/WelcomeModal.vue'

function render() {
  return mount(WelcomeModal, {
    props: { open: true, actorId: 'act_1', handle: 'jose', name: 'José Silva' },
    global: { stubs: { teleport: true } },
  })
}

function button(view: ReturnType<typeof mount>, text: string) {
  return view.findAll('button').find((b) => b.text().includes(text))!
}

describe('WelcomeModal', () => {
  beforeEach(() => {
    uploadAvatar.mockReset()
    uploadAvatar.mockResolvedValue({ ok: true, avatar_url: '/a.png' })
    markOnspaceed.mockClear()
    setTheme.mockClear()
  })

  it('greets by first name, not by handle or full name', async () => {
    expect(render().text()).toContain('Welcome to Acta, José')
  })

  // The point of recording it server-side: someone who changes nothing has
  // still been asked, and asking again is how a welcome becomes a nuisance.
  it('records onboarding even when nothing was changed', async () => {
    const view = render()
    await button(view, 'Skip for now').trigger('click')
    await flushPromises()

    expect(markOnspaceed).toHaveBeenCalledTimes(1)
    expect(uploadAvatar).not.toHaveBeenCalled()
    expect(view.emitted('done')?.[0]).toEqual([false])
  })

  it('asks for the tour when that is the button pressed', async () => {
    const view = render()
    await button(view, 'Show me around').trigger('click')
    await flushPromises()

    expect(markOnspaceed).toHaveBeenCalledTimes(1)
    expect(view.emitted('done')?.[0]).toEqual([true])
  })

  it('applies a theme choice immediately rather than on save', async () => {
    const view = render()
    const light = view.findAll('input[type="radio"]')[0]
    await light.setValue()
    await flushPromises()

    expect(setTheme).toHaveBeenCalledWith('light')
    // Still open: choosing a theme is not a commitment to leaving.
    expect(view.emitted('done')).toBeUndefined()
  })

  it('does not trap anyone behind a failed upload', async () => {
    // Rejects every time, not just once: with a one-shot rejection the retry
    // below would succeed even if the offending blob were still attached,
    // and the test would prove nothing.
    uploadAvatar.mockRejectedValue(new Error('file too large'))
    const view = render()
    // Pretend a crop happened, which is the only way uploadAvatar is reached.
    ;(view.vm as unknown as { cropped: Blob | null }).cropped = new Blob(['x'])
    await flushPromises()

    await button(view, 'Show me around').trigger('click')
    await flushPromises()

    // The banner says something happened without quoting the exception:
    // humanise() exists so raw error text never reaches a reader.
    expect(view.text()).toContain('Something went wrong')
    expect(view.text()).not.toContain('file too large')
    expect(view.emitted('done')).toBeUndefined()

    // The offending picture is dropped, so the next press gets through
    // instead of failing on the same blob forever.
    await button(view, 'Show me around').trigger('click')
    await flushPromises()
    expect(markOnspaceed).toHaveBeenCalled()
    expect(view.emitted('done')?.[0]).toEqual([true])
    // Once, from the first press. The second got through precisely because
    // there was no longer a picture to upload.
    expect(uploadAvatar).toHaveBeenCalledTimes(1)
  })
})
