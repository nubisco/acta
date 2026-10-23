/**
 * The rail (2026-10-23). The brand used to double as the workspace switcher,
 * and the collapse toggle now swaps onto the collapsed brand under the
 * pointer, so switching moved to a destination of its own: Workspaces, first
 * in the rail, then the open workspace named above its destinations. These pin
 * that order, that the entry survives the collapsed rail, and that the
 * collapsed rail still reaches every space.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, provide, ref } from 'vue'

const route = ref<{ name: string; params: Record<string, string> }>({
  name: 'home',
  params: { workspace: 'acme' },
})

vi.mock('vue-router', () => ({
  useRoute: () =>
    new Proxy({}, { get: (_t, key: string) => (route.value as never)[key] }),
}))

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
    expect(rows.slice(1, 5)).toEqual(['Home', 'Activity', 'Goals', 'Docs'])
    const first = wrapper.find('.nb-sidebar-menu-item__row')
    expect(first.attributes('href')).toBe('/')
    const groups = wrapper
      .findAll('.nb-sidebar-menu-group__label')
      .map((label) => label.text())
    expect(groups).toEqual(['Acme', 'Spaces'])
    // Archived spaces stay out of the rail.
    expect(rows).toContain('Studio3')
    expect(rows.join()).not.toContain('Old')
    wrapper.unmount()
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
})
