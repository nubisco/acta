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
/** The space's own menu. The actions are in useSpaceActions. */
import { ref } from 'vue'
import type { NbMenu } from '@nubisco/ui'
import { useSpaceActions } from '@/composables/useSpaceActions'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{
  spaceKey: string
  spaceName: string
  cards: number
}>()

const ws = useWorkspace()
const { archive, remove } = useSpaceActions(() => props)
const open = ref(false)
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
