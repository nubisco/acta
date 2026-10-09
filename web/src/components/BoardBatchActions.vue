<template>
  <!-- What can be done to every selected card at once (Jose, 2026-10-09).
       Each opens a short menu; picking an entry acts on the whole selection.
       Labels and literal icon names, since the library links icon artwork at
       build time. -->
  <span class="batch">
    <NbButton
      ref="moveBtn"
      variant="ghost"
      size="sm"
      icon="arrow-square-right"
      @click="toggle('move', moveBtn)"
    >
      Move to
    </NbButton>
    <NbButton
      ref="assignBtn"
      variant="ghost"
      size="sm"
      icon="user-plus"
      @click="toggle('assign', assignBtn)"
    >
      Assign
    </NbButton>
    <NbButton
      ref="labelBtn"
      variant="ghost"
      size="sm"
      icon="tag"
      @click="toggle('label', labelBtn)"
    >
      Label
    </NbButton>
    <NbButton
      ref="priorityBtn"
      variant="ghost"
      size="sm"
      icon="flag"
      @click="toggle('priority', priorityBtn)"
    >
      Priority
    </NbButton>
    <NbButton variant="ghost" size="sm" icon="archive" @click="emit('archive')">
      Archive
    </NbButton>

    <NbMenu
      ref="menu"
      v-model:open="open"
      size="sm"
      :min-width="220"
      :max-width="320"
      @close="open = false"
    >
      <template v-if="which === 'move'">
        <NbMenuItem
          v-for="list in lists"
          :key="list"
          :label="list"
          @select="pick(() => emit('move', list))"
        />
      </template>
      <template v-else-if="which === 'assign'">
        <NbMenuItem
          v-for="person in people"
          :key="person.handle"
          :label="person.name"
          @select="pick(() => emit('assign', person.handle))"
        />
      </template>
      <template v-else-if="which === 'label'">
        <NbMenuItem
          v-for="label in labels"
          :key="label.id"
          :label="label.name"
          @select="pick(() => emit('label', label.id))"
        />
      </template>
      <template v-else-if="which === 'priority'">
        <NbMenuItem
          v-for="option in PRIORITY_OPTIONS"
          :key="option.value || 'none'"
          :label="option.label"
          @select="pick(() => emit('priority', option.value || null))"
        />
      </template>
    </NbMenu>
  </span>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { NbMenu } from '@nubisco/ui'
import { PRIORITY_OPTIONS, type TPriority } from '@/lib/priority'

defineProps<{
  lists: string[]
  people: { handle: string; name: string }[]
  labels: { id: string; name: string }[]
}>()

const emit = defineEmits<{
  move: [list: string]
  assign: [handle: string]
  label: [labelId: string]
  priority: [priority: TPriority | null]
  archive: []
}>()

type TWhich = 'move' | 'assign' | 'label' | 'priority'
const which = ref<TWhich>('move')
const open = ref(false)
const menu = ref<InstanceType<typeof NbMenu> | null>(null)
const moveBtn = ref<{ $el: HTMLElement } | null>(null)
const assignBtn = ref<{ $el: HTMLElement } | null>(null)
const labelBtn = ref<{ $el: HTMLElement } | null>(null)
const priorityBtn = ref<{ $el: HTMLElement } | null>(null)

function toggle(next: TWhich, button: { $el: HTMLElement } | null): void {
  if (open.value && which.value === next) {
    open.value = false
    return
  }
  which.value = next
  const rect = button?.$el?.getBoundingClientRect()
  // Above the button: the bar sits at the foot of the board.
  if (rect) menu.value?.setPositionXY(rect.left, rect.top - 8)
  open.value = true
}

function pick(run: () => void): void {
  open.value = false
  run()
}
</script>

<style scoped lang="scss">
.batch {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--nb-spacing-4);
}
</style>
