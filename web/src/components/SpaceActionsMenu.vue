<template>
  <NbButton
    ref="trigger"
    v-nb-tooltip="{ body: 'Space actions' }"
    size="sm"
    variant="ghost"
    icon="dots-three"
    aria-label="Space actions"
    @click="toggle"
  />
  <NbMenu
    ref="menu"
    v-model:open="open"
    size="sm"
    :min-width="240"
    @close="open = false"
  >
    <NbMenuItem
      icon="sliders-horizontal"
      label="Space settings"
      @select="pick(openSettings)"
    />
    <NbMenuDivider />
    <NbMenuItem icon="archive" label="Archive space" @select="pick(archive)" />
    <NbMenuItem
      v-if="ws.isAdmin.value"
      icon="trash"
      label="Delete space"
      :disabled="cards > 0"
      @select="pick(remove)"
    />
  </NbMenu>
</template>

<script setup lang="ts">
/**
 * The space's own menu: a way to its Settings, and archive and delete kept as
 * shortcuts from there. The actions are in useSpaceActions.
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import type { NbMenu } from '@nubisco/ui'
import { useSpaceActions } from '@/composables/useSpaceActions'
import { useWorkspace } from '@/stores/workspace'
import { wpath } from '@/lib/paths'

const props = defineProps<{
  spaceKey: string
  spaceName: string
  cards: number
}>()

const ws = useWorkspace()
const { archive, remove } = useSpaceActions(() => props)
const router = useRouter()
const open = ref(false)

function openSettings(): void {
  void router.push(wpath(`/s/${props.spaceKey}/settings`))
}
const menu = ref<InstanceType<typeof NbMenu> | null>(null)
const trigger = ref<{ $el: HTMLElement } | null>(null)

function toggle(): void {
  const rect = trigger.value?.$el?.getBoundingClientRect()
  if (rect) menu.value?.setPositionXY(rect.right - 240, rect.bottom + 4)
  open.value = !open.value
}

function pick(run: () => void): void {
  open.value = false
  run()
}
</script>
