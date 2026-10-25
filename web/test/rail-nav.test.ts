/**
 * The rail (2026-10-23, and the fleet anatomy of 2026-10-24). The brand used to double as the workspace switcher,
 * and the collapse toggle now swaps onto the collapsed brand under the
 * pointer, so switching moved to a destination of its own: Workspaces, first
 * in the rail, then the open workspace named above its destinations. These pin
 * that order, that the entry survives the collapsed rail, and that the
 * collapsed rail still reaches every space. Since 2026-10-24 the space you
 * are in is a group of its own, headed with its name, holding its views and
 * then its Settings, last.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, provide, ref } from 'vue'

const route = ref<{
  name: string
  params: Record<string, string>
  query?: Record<string, string>
}>({
  name: 'home',
  params: { workspace: 'acme' },
})

vi.mock('vue-router', () => ({
  useRoute: () =>
    new Proxy({}, { get: (_t, key: string) => (route.value as never)[key] }),
}))

const phone = vi.hoisted(() => ({ value: false }))
vi.mock('@nubisco/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const { ref: vueRef } = await import('vue')
  const signal = vueRef(false)
  Object.defineProperty(phone, 'value', {
    get: () => signal.value,
    set: (on: boolean) => (signal.value = on),
  })
  return {
    ...actual,
    usePhoneLayout: () => ({ phone: signal, phoneTouch: signal }),
  }
})

vi.mock('@/api/client', () => ({
  getWorkspaceSlug: () => 'acme',
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    workspaceSlug: computed(() => 'acme'),
    overview: computed(() => ({
      workspace: { name: 'Acme' },
      spaces: [
        { key: 'ST', name: 'Studio', archived: false, lists: [{ items: 3 }] },
        { key: 'OLD', name: 'Old', archived: true, lists: [] },
        { key: 'WEB', name: 'Website', archived: false, lists: [] },
      ],
    })),
  }),
}))

import RailNav from '@/components/RailNav.vue'

function mountRail(variant: 'verbose' | 'compact') {
  const Host = defineComponent({
    setup() {
      provide('nb-shell-sidebar-variant', ref(variant))
      return () => h(RailNav, { compact: variant === 'compact' })
    },
  })
  return mount(Host, { attachTo: document.body })
}

describe('the rail', () => {
  it('leads with Workspaces, then the open workspace and its destinations', () => {
    const wrapper = mountRail('verbose')
    const rows = wrapper
      .findAll('.nb-sidebar-menu-item__row')
      .map((row) => row.text())
    expect(rows[0]).toBe('Workspaces')
    expect(rows.slice(1, 6)).toEqual([
      'Home',
      'Activity',
      'Goals',
      'Docs',
      'Spaces',
    ])
    const first = wrapper.find('.nb-sidebar-menu-item__row')
    expect(first.attributes('href')).toBe('/')
    // No space chosen on Home, so the workspace is the only group.
    const groups = wrapper
      .findAll('.nb-sidebar-menu-group__label')
      .map((label) => label.text())
    expect(groups).toEqual(['Acme'])
    // The space list opens in place, and leaves archived spaces out.
    const spaces = wrapper
      .findAll('.nb-sidebar-menu-item__row')
      .find((row) => row.text() === 'Spaces')
    expect(spaces?.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('lists every open space under Spaces, with its open count', async () => {
    const wrapper = mountRail('verbose')
    const spaces = wrapper
      .findAll('.nb-sidebar-menu-item__row')
      .find((row) => row.text() === 'Spaces')
    await spaces!.trigger('click')
    const rows = wrapper
      .findAll('.nb-sidebar-menu-item__row')
      .map((row) => row.text())
    expect(rows).toContain('Studio3')
    expect(rows).toContain('Website')
    expect(rows.join()).not.toContain('Old')
    wrapper.unmount()
  })

  it('draws Docs with file-text, so it does not read as Documentation', () => {
    const wrapper = mountRail('verbose')
    const docs = wrapper
      .findAll('.nb-sidebar-menu-item__row')
      .find((row) => row.text() === 'Docs')
    expect(docs?.html()).toContain('file-text')
    expect(docs?.html()).not.toContain('book')
    wrapper.unmount()
  })

  it('gives the chosen space a group of its own, with Settings last', () => {
    route.value = {
      name: 'space',
      params: { workspace: 'acme', spaceKey: 'ST' },
      query: { view: 'table' },
    }
    const wrapper = mountRail('verbose')
    const groups = wrapper.findAll('.nb-sidebar-menu-group')
    expect(
      groups.map((g) => g.find('.nb-sidebar-menu-group__label').text()),
    ).toEqual(['Acme', 'Studio'])
    const space = groups[1]
      .findAll('.nb-sidebar-menu-item__row')
      .map((row) => ({
        text: row.text(),
        href: row.attributes('href'),
        active: row.classes().includes('nb-sidebar-menu-item__row--active'),
      }))
    expect(space.map((r) => r.text)).toEqual([
      'Board',
      'Table',
      'Calendar',
      'Timeline',
      'Sequence',
      'Response times',
      'Settings',
    ])
    expect(space[0].href).toBe('/acme/s/ST')
    expect(space[1].href).toBe('/acme/s/ST?view=table')
    expect(space[6].href).toBe('/acme/s/ST/settings')
    // The view in the URL is the one marked, and only it.
    expect(space.filter((r) => r.active).map((r) => r.text)).toEqual(['Table'])
    expect(groups[1].html()).toContain('sliders-horizontal')
    wrapper.unmount()
    route.value = { name: 'home', params: { workspace: 'acme' } }
  })

  it('marks Settings, and no view, on the space settings page', () => {
    route.value = {
      name: 'space-settings',
      params: { workspace: 'acme', spaceKey: 'ST' },
    }
    const wrapper = mountRail('verbose')
    // The space is marked in the Spaces list too, which is how its flyout
    // says where you are. Among the space's own entries, only Settings.
    const group = wrapper.findAll('.nb-sidebar-menu-group')[1]
    const active = group
      .findAll('.nb-sidebar-menu-item__row--active')
      .map((row) => row.text())
    expect(active).toEqual(['Settings'])
    wrapper.unmount()
    route.value = { name: 'home', params: { workspace: 'acme' } }
  })

  it('still names an archived space opened from Home', () => {
    route.value = {
      name: 'space-settings',
      params: { workspace: 'acme', spaceKey: 'OLD' },
    }
    const wrapper = mountRail('verbose')
    const groups = wrapper
      .findAll('.nb-sidebar-menu-group__label')
      .map((label) => label.text())
    expect(groups).toEqual(['Acme', 'Old'])
    wrapper.unmount()
    route.value = { name: 'home', params: { workspace: 'acme' } }
  })

  it('marks Workspaces active on the workspace list', () => {
    route.value = { name: 'workspaces', params: {} }
    const wrapper = mountRail('verbose')
    const first = wrapper.find('.nb-sidebar-menu-item__row')
    expect(first.classes()).toContain('nb-sidebar-menu-item__row--active')
    // The open workspace is still there below it, so the way back is one
    // click, and its links still carry the workspace segment.
    const home = wrapper
      .findAll('.nb-sidebar-menu-item__row')
      .find((row) => row.text() === 'Home')
    expect(home?.attributes('href')).toBe('/acme/')
    wrapper.unmount()
    route.value = { name: 'home', params: { workspace: 'acme' } }
  })

  it('keeps the Workspaces entry reachable when the rail is collapsed', () => {
    const wrapper = mountRail('compact')
    const labels = wrapper
      .findAll('.nb-sidebar-menu-item__row')
      .map((row) => row.attributes('aria-label'))
    expect(labels).toEqual([
      'Workspaces',
      'Home',
      'Activity',
      'Goals',
      'Docs',
      'Spaces',
    ])
    expect(wrapper.find('.nb-sidebar-menu-item__row').attributes('href')).toBe(
      '/',
    )
    wrapper.unmount()
  })

  it('keeps the chosen space and its Settings on the collapsed rail', () => {
    route.value = {
      name: 'space',
      params: { workspace: 'acme', spaceKey: 'ST' },
    }
    const wrapper = mountRail('compact')
    const labels = wrapper
      .findAll('.nb-sidebar-menu-item__row')
      .map((row) => row.attributes('aria-label'))
    expect(labels.slice(6)).toEqual([
      'Board',
      'Table',
      'Calendar',
      'Timeline',
      'Sequence',
      'Response times',
      'Settings',
    ])
    wrapper.unmount()
    route.value = { name: 'home', params: { workspace: 'acme' } }
  })

  // The desktop has no view tabs above the board any more (2026-10-24), so
  // the walkthrough's views step points at this group instead. A phone keeps
  // the tabs, and the step with them, so the rail does not claim it there.
  it('carries the views walkthrough step on a desktop, and not on a phone', async () => {
    route.value = {
      name: 'space',
      params: { workspace: 'acme', spaceKey: 'ST' },
    }
    const desktop = mountRail('verbose')
    const groups = desktop.findAll('.nb-sidebar-menu-group')
    expect(groups[1].attributes('data-nb-tour-step')).toBe('space-views')
    desktop.unmount()

    phone.value = true
    const onPhone = mountRail('verbose')
    expect(onPhone.find('[data-nb-tour-step="space-views"]').exists()).toBe(
      false,
    )
    onPhone.unmount()
    phone.value = false
    route.value = { name: 'home', params: { workspace: 'acme' } }
  })
})
