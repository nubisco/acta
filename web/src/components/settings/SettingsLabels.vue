<template>
  <div class="labels-settings">
    <NbPanel
      v-for="group in groups"
      :key="groupKey(group)"
      class="labels-settings__group"
    >
      <header class="labels-settings__head">
        <div class="labels-settings__title">
          <h2 class="type-heading-01">{{ group.name }}</h2>
          <NbBadge size="sm" variant="grey">
            {{ group.space ? spaceName(group.space) : 'Workspace' }}
          </NbBadge>
          <span class="labels-settings__count">
            {{ group.labels.length }}
            {{ group.labels.length === 1 ? 'label' : 'labels' }}
          </span>
        </div>
        <NbButton
          v-if="ws.isAdmin.value"
          size="sm"
          variant="primary"
          icon="plus"
          @click="openCreate(group)"
        >
          New label
        </NbButton>
      </header>

      <NbDataTable
        :columns="columns"
        :rows="rowsFor(group)"
        row-key="id"
        size="sm"
        :aria-label="`Labels in ${group.name}`"
      >
        <template #cell-label="{ row }">
          <NbBadge
            size="md"
            :variant="variants.get(String(row.name)) ?? 'grey'"
          >
            {{ row.name }}
          </NbBadge>
        </template>
        <template #cell-color="{ row }">
          <span class="labels-settings__color">
            <span
              class="labels-settings__swatch"
              :style="{ background: swatch(String(row.color)) }"
              aria-hidden="true"
            />
            {{ row.color }}
          </span>
        </template>
        <template #cell-actions="{ row }">
          <div class="labels-settings__actions">
            <NbButton
              size="sm"
              variant="ghost"
              icon="pencil-simple"
              :aria-label="`Edit label ${row.name}`"
              @click="openEdit(group, String(row.id))"
            />
            <NbButton
              size="sm"
              variant="ghost"
              icon="arrows-merge"
              :aria-label="`Merge label ${row.name} into another`"
              :disabled="group.labels.length < 2"
              @click="openMerge(group, String(row.id))"
            />
            <NbButton
              size="sm"
              variant="danger"
              outlined
              icon="trash-simple"
              :aria-label="`Delete label ${row.name}`"
              @click="remove(group, String(row.id))"
            />
          </div>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="No labels in this group"
            description="Add one and it becomes available on every item in scope."
          />
        </template>
      </NbDataTable>
    </NbPanel>

    <NbEmptyState
      v-if="groups.length === 0"
      size="sm"
      title="No labels yet"
      description="Labels are created on spaces or through imports and can be managed here."
    />

    <LabelEditModal
      :open="editing !== null"
      :label="editing?.label ?? null"
      :group-name="editing?.group.name ?? ''"
      :siblings="editing?.siblings ?? []"
      :mode="editing?.mode ?? 'edit'"
      @close="editing = null"
      @saved="editing = null"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * Labels, on the same furniture as every other list in Settings.
 *
 * This pane used to be a hand-built row of controls per label: an inline
 * edit, two bare selects and a delete, behind a "Manage" mode toggle, while
 * members, webhooks and tokens all used the shared table. It read as a
 * different product. Editing now happens in a dialog, which is the pattern
 * the design system documents, and it also fixes a real defect: the create
 * form's name field was a single ref shared by every group on the page.
 */
import { computed, ref } from 'vue'
import { useConfirm, useToast } from '@nubisco/ui'
import { api, newOpId as opId } from '@/api/client'
import { humanise } from '@/lib/state'
import { labelVariants } from '@/lib/labels'
import { useWorkspace } from '@/stores/workspace'
import LabelEditModal from '@/components/settings/LabelEditModal.vue'
import type { ILabelGroupView, ILabelView } from '@/components/settings/labels'

const ws = useWorkspace()
const toast = useToast()
const confirm = useConfirm()

const columns = [
  { key: 'label', header: 'Label' },
  { key: 'name', header: 'Name' },
  { key: 'color', header: 'Colour' },
  { key: 'actions', header: '' },
]

const variants = computed(() => labelVariants(ws.overview.value))

const groups = computed<ILabelGroupView[]>(() => {
  const out = new Map<string, ILabelGroupView>()
  for (const label of ws.overview.value?.labels ?? []) {
    const key = `${label.group_name}:${label.space_key ?? ''}`
    if (!out.has(key))
      out.set(key, {
        name: label.group_name,
        space: label.space_key,
        labels: [],
      })
    out.get(key)!.labels.push({
      id: label.id,
      name: label.name,
      color: label.color,
    })
  }
  return [...out.values()]
})

function groupKey(group: ILabelGroupView): string {
  return `${group.name}:${group.space ?? ''}`
}

function spaceName(key: string): string {
  return ws.overview.value?.spaces.find((b) => b.key === key)?.name ?? key
}

function rowsFor(group: ILabelGroupView) {
  return group.labels.map((l) => ({ id: l.id, name: l.name, color: l.color }))
}

/** The dot beside the colour name, so the word is not the only cue. */
function swatch(color: string): string {
  return `var(--nb-c-${color}-500, var(--nb-c-text-subtle))`
}

const editing = ref<{
  mode: 'create' | 'edit' | 'merge'
  group: ILabelGroupView
  label: ILabelView | null
  siblings: ILabelView[]
} | null>(null)

function find(group: ILabelGroupView, id: string): ILabelView | null {
  return group.labels.find((l) => l.id === id) ?? null
}

function openCreate(group: ILabelGroupView): void {
  editing.value = { mode: 'create', group, label: null, siblings: group.labels }
}

function openEdit(group: ILabelGroupView, id: string): void {
  editing.value = {
    mode: 'edit',
    group,
    label: find(group, id),
    siblings: group.labels.filter((l) => l.id !== id),
  }
}

function openMerge(group: ILabelGroupView, id: string): void {
  editing.value = {
    mode: 'merge',
    group,
    label: find(group, id),
    siblings: group.labels.filter((l) => l.id !== id),
  }
}

function remove(group: ILabelGroupView, id: string): void {
  const label = find(group, id)
  if (!label) return
  void confirm({
    title: 'Delete label',
    message: 'It is removed from every item that carries it.',
    subject: label.name,
    confirmLabel: 'Delete label',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      try {
        const { results } = await api.labelWrite([
          { op: 'label_delete', op_id: opId(), label: label.id },
        ])
        const bad = results.find((r) => !r.ok)
        if (bad) throw new Error((bad as { error: string }).error)
        await ws.refresh()
      } catch (err) {
        toast.error(humanise(err), { title: 'Delete failed' })
      }
    },
  })
}
</script>

<style scoped lang="scss">
.labels-settings {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);

  &__group {
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-16);
  }

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-spacing-16);
  }

  &__title {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__count {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

  &__color {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__swatch {
    inline-size: 0.75rem;
    block-size: 0.75rem;
    border-radius: 50%;
    border: 1px solid var(--nb-c-border);
  }

  &__actions {
    display: flex;
    gap: var(--nb-spacing-4);
    justify-content: end;
  }
}
</style>
