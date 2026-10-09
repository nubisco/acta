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
/**
 * Archiving and deleting a space (Jose, 2026-10-09: an empty board had no
 * way of being removed). Like a card: archive hides it and can be undone
 * from Home, delete is for good. An empty space can be deleted here
 * directly; one with cards is archived first and deleted from Home's
 * archived spaces, where its contents are spelled out. Admins only.
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useConfirm, useToast, type NbMenu } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { wpath } from '@/lib/paths'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{
  spaceKey: string
  spaceName: string
  cards: number
}>()

const ws = useWorkspace()
const router = useRouter()
const confirm = useConfirm()
const toast = useToast()
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

async function write(op: 'archive' | 'delete'): Promise<void> {
  const { results } = await api.spaceWrite([
    { op, op_id: newOpId(), key: props.spaceKey },
  ])
  if (!results[0]?.ok) throw new Error(String(results[0]?.error ?? 'failed'))
  await ws.refresh()
  await router.push(wpath('/'))
}

async function archive(): Promise<void> {
  await confirm({
    title: `Archive ${props.spaceName}?`,
    message:
      'It leaves the sidebar and Home, with everything in it kept. Bring it back any time from Archived spaces on Home.',
    confirmLabel: 'Archive space',
    cancelLabel: 'Keep it',
    tone: 'neutral',
    onConfirm: async () => {
      await write('archive')
      toast.success(`${props.spaceName} archived.`)
    },
    formatError: humanise,
  })
}

async function remove(): Promise<void> {
  await confirm({
    title: `Delete ${props.spaceName}?`,
    message:
      'It has no cards, so only its lists go with it. This cannot be undone.',
    subject: props.spaceName,
    subjectLabel: 'Space',
    confirmLabel: 'Delete space',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      await write('delete')
      toast.success(`${props.spaceName} deleted.`)
    },
    formatError: humanise,
  })
}
</script>
