<template>
  <div class="labels-settings">
    <p class="labels-settings__lede">
      Labels are grouped, and a group is a field: "Fixes version" names one
      release, "Affects version" names several. Drag a label to set where it
      sits in its group, which is the order every picker shows: 1.9.0 belongs
      before 1.11.0 and sorting by name says otherwise. Turning on "One value
      per card" applies from then on. Cards that already carry several keep
      them, because a setting should not quietly delete work somebody did.
    </p>

    <NbPanel
      v-for="group in groups"
      :key="group.id"
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

      <div class="labels-settings__option">
        <NbSwitch
          size="sm"
          label="One value per card"
          :name="`exclusive-${group.name}`"
          :model-value="group.exclusive"
          :disabled="!ws.isAdmin.value"
          @update:model-value="
            (on?: boolean) => setExclusive(group, on === true)
          "
        />
        <NbInfoHint
          title="One value per card"
          :label="`About one value per card in ${group.name}`"
          text="A card can carry at most one label from this group, and picking a second replaces the first. Cards that already carry several are left alone: they settle the next time somebody edits them."
        />
      </div>

      <NbReorderList
        :model-value="group.labels"
        item-key="id"
        :disabled="!ws.isAdmin.value"
        :label="`Labels in ${group.name}`"
        class="labels-settings__list"
        @update:model-value="(next: ILabelEntry[]) => reorder(group, next)"
      >
        <template #default="{ item }">
          <div class="labels-settings__row">
            <LabelBadge :id="item.id" size="md" />
            <span class="labels-settings__color">
              <span
                class="labels-settings__swatch"
                :style="{ background: swatch(item.color) }"
                aria-hidden="true"
              />
              {{ item.color }}
            </span>
            <div class="labels-settings__actions">
              <NbButton
                size="sm"
                variant="ghost"
                icon="pencil-simple"
                :aria-label="`Edit label ${item.name}`"
                @click="openEdit(group, item.id)"
              />
              <NbButton
                size="sm"
                variant="ghost"
                icon="arrows-merge"
                :aria-label="`Merge label ${item.name} into another`"
                :disabled="group.labels.length < 2"
                @click="openMerge(group, item.id)"
              />
              <NbButton
                size="sm"
                variant="danger"
                outlined
                icon="trash-simple"
                :aria-label="`Delete label ${item.name}`"
                @click="remove(item)"
              />
            </div>
          </div>
        </template>
      </NbReorderList>

      <NbEmptyState
        v-if="group.labels.length === 0"
        size="sm"
        title="No labels in this group"
        description="Add one and it becomes available on every item in scope."
      />
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
 *
 * The labels themselves are an `NbReorderList` rather than the shared
 * `NbDataTable`, because their order is now part of the data: a version
 * group is only useful arranged, and a table cannot be dragged. The rest of
 * the pane keeps the panel furniture the other panes use.
 */
import { computed, ref } from 'vue'
import { useConfirm, useToast } from '@nubisco/ui'
import { api, newOpId as opId } from '@/api/client'
import { humanise } from '@/lib/state'
import { labelGroups } from '@/lib/labels'
import type { ILabelEntry, ILabelGroup } from '@/lib/labels'
import { useWorkspace } from '@/stores/workspace'
import LabelBadge from '@/components/LabelBadge.vue'
import LabelEditModal from '@/components/settings/LabelEditModal.vue'
import type { ILabelView } from '@/components/settings/labels'

const ws = useWorkspace()
const toast = useToast()
const confirm = useConfirm()

/**
 * Straight from the catalogue, which the server already returns by group and
 * then by each group's own arrangement. Sorting it here would undo the
 * ordering this pane exists to let people set.
 */
const groups = computed<ILabelGroup[]>(() => labelGroups(ws.overview.value))

function spaceName(key: string): string {
  return ws.overview.value?.spaces.find((b) => b.key === key)?.name ?? key
}

/** The dot beside the colour name, so the word is not the only cue. */
function swatch(color: string): string {
  return `var(--nb-c-${color}-500, var(--nb-c-text-subtle))`
}

const editing = ref<{
  mode: 'create' | 'edit' | 'merge'
  group: ILabelGroup
  label: ILabelView | null
  siblings: ILabelView[]
} | null>(null)

function view(label: ILabelEntry): ILabelView {
  return { id: label.id, name: label.name, color: label.color }
}

function find(group: ILabelGroup, id: string): ILabelView | null {
  const label = group.labels.find((l) => l.id === id)
  return label ? view(label) : null
}

function openCreate(group: ILabelGroup): void {
  editing.value = {
    mode: 'create',
    group,
    label: null,
    siblings: group.labels.map(view),
  }
}

function openEdit(group: ILabelGroup, id: string): void {
  editing.value = {
    mode: 'edit',
    group,
    label: find(group, id),
    siblings: group.labels.filter((l) => l.id !== id).map(view),
  }
}

function openMerge(group: ILabelGroup, id: string): void {
  editing.value = {
    mode: 'merge',
    group,
    label: find(group, id),
    siblings: group.labels.filter((l) => l.id !== id).map(view),
  }
}

/** One op, one refresh, one place to turn a failed op into a toast. */
async function run(
  op: Parameters<typeof api.labelWrite>[0][number],
  failure: string,
): Promise<void> {
  try {
    const { results } = await api.labelWrite([op])
    const bad = results.find((r) => !r.ok)
    if (bad) throw new Error((bad as { error: string }).error)
    await ws.refresh()
  } catch (err) {
    toast.error(humanise(err), { title: failure })
    await ws.refresh()
  }
}

function setExclusive(group: ILabelGroup, on: boolean): void {
  void run(
    { op: 'group_update', op_id: opId(), group: group.id, exclusive: on },
    'Could not change the group',
  )
}

/**
 * The whole group in the order the drag produced, in one op. The server
 * assigns the positions from that order, so nothing here invents numbers or
 * has to know what the neighbours hold.
 */
function reorder(group: ILabelGroup, next: ILabelEntry[]): void {
  void run(
    {
      op: 'label_reorder',
      op_id: opId(),
      group: group.id,
      labels: next.map((l) => l.id),
    },
    'Could not reorder',
  )
}

function remove(label: ILabelEntry): void {
  void confirm({
    title: 'Delete label',
    message: 'It is removed from every item that carries it.',
    subject: label.name,
    confirmLabel: 'Delete label',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      await run(
        { op: 'label_delete', op_id: opId(), label: label.id },
        'Delete failed',
      )
    },
  })
}
</script>

<style scoped lang="scss">
.labels-settings {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);

  &__lede {
    max-width: 68ch;
    margin: 0;
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

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

  &__option {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  /* A label row: the chip, then the colour, then the controls hard right. */
  &__row {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-16);
    min-inline-size: 0;
  }

  &__color {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    flex: 1;
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
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
