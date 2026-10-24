<template>
  <div class="space-settings">
    <h1 class="type-heading-03">Settings</h1>

    <NbEmptyState
      v-if="!space"
      kind="error"
      title="No such space"
      :description="`There is no space ${spaceKey} in this workspace.`"
    />

    <template v-else>
      <NbBanner
        v-if="archived"
        status="warning"
        variant="callout"
        title="This space is archived. It is out of the rail and Home, with everything in it kept. Restore it at the foot of this page."
      />

      <!-- What the space is called and what it is for. -->
      <NbPanel class="space-settings__section">
        <header>
          <h2 class="type-heading-01">Space</h2>
        </header>
        <form class="space-settings__form" @submit.prevent="saveDetails">
          <NbTextInput
            id="space-settings-name"
            v-model="name"
            label="Name"
            :maxlength="200"
            required
          />
          <NbTextInput
            id="space-settings-key"
            :model-value="space.key"
            label="Key"
            readonly
            :helper="`Every card here is numbered from it (${space.key}-1, ${space.key}-2), and links to cards carry it, so it does not change.`"
          />
          <NbTextInput
            id="space-settings-description"
            v-model="description"
            label="Description"
            multiline
            :rows="4"
            :maxlength="10000"
            helper="What this space is for. Agents read it before they file cards here."
          />
          <div class="space-settings__actions">
            <NbButton
              type="submit"
              variant="primary"
              :disabled="!detailsDirty || !name.trim()"
              :loading="savingDetails"
            >
              Save
            </NbButton>
          </div>
        </form>
      </NbPanel>

      <!-- The columns of the board. -->
      <NbPanel class="space-settings__section">
        <header class="space-settings__head">
          <div>
            <h2 class="type-heading-01">Lists</h2>
            <p class="space-settings__lede">
              The columns of the board, in order. Drag one to move it. A list's
              role says what being in it means: open counts, the progress bar on
              Home and the done window all read it.
            </p>
          </div>
        </header>

        <NbReorderList
          :model-value="lists"
          item-key="id"
          label="Lists in this space"
          class="space-settings__lists"
          @update:model-value="reorder"
        >
          <template #default="{ item }">
            <div class="space-settings__list">
              <NbTextInput
                :id="`list-name-${item.id}`"
                :model-value="item.name"
                size="sm"
                :aria-label="`Name of ${item.name}`"
                :maxlength="200"
                @change="
                  (event: Event) =>
                    renameList(item, (event.target as HTMLInputElement).value)
                "
              />
              <NbSelect
                :id="`list-role-${item.id}`"
                size="sm"
                :model-value="item.role ?? 'none'"
                :options="ROLE_OPTIONS"
                :aria-label="`Role of ${item.name}`"
                @update:model-value="(role) => setRole(item, String(role))"
              />
              <span class="space-settings__count">
                {{ item.items }} {{ item.items === 1 ? 'card' : 'cards' }}
              </span>
              <NbButton
                v-nb-tooltip="{
                  body:
                    item.items > 0
                      ? 'Move or archive its cards first'
                      : `Archive ${item.name}`,
                }"
                size="sm"
                variant="ghost"
                icon="archive"
                :aria-label="`Archive list ${item.name}`"
                :disabled="item.items > 0"
                @click="archiveList(item)"
              />
            </div>
          </template>
        </NbReorderList>

        <form class="space-settings__add" @submit.prevent="addList">
          <NbTextInput
            id="space-settings-new-list"
            v-model="newListName"
            size="sm"
            label="New list"
            placeholder="Name"
            :maxlength="200"
          />
          <NbSelect
            id="space-settings-new-list-role"
            v-model="newListRole"
            size="sm"
            label="Role"
            :options="ROLE_OPTIONS"
          />
          <NbButton
            type="submit"
            size="sm"
            variant="secondary"
            icon="plus"
            :disabled="!newListName.trim()"
          >
            Add list
          </NbButton>
        </form>
      </NbPanel>

      <!-- How long done cards stay on the board. The Done column's own menu
           keeps the same controls where the cards are. -->
      <NbPanel class="space-settings__section">
        <header>
          <h2 class="type-heading-01">Done cards</h2>
          <p class="space-settings__lede">
            A card leaves the board a set number of days after it became done.
            Nothing is archived: it stays in search, in the Table view under
            "Done cards" and in its goals' progress.
          </p>
        </header>
        <div class="space-settings__done">
          <NbSelect
            id="space-settings-done-window"
            label="Keep done cards on the board"
            :model-value="doneWindowValue"
            :options="WINDOW_OPTIONS"
            @update:model-value="(v) => setDoneWindow(v)"
          />
          <NbButton variant="secondary" icon="broom" @click="clearDone">
            Clear done now
          </NbButton>
        </div>
      </NbPanel>

      <!-- Space settings kept with the rest of their kind, so this says
           where they are rather than splitting them. -->
      <NbPanel class="space-settings__section">
        <header>
          <h2 class="type-heading-01">Labels and automation</h2>
          <p class="space-settings__lede">
            Labels made for this space, and the forms, tokens and connections
            that file cards into it, are managed with the rest of the
            workspace's, so they can be compared side by side.
          </p>
        </header>
        <div class="space-settings__actions">
          <NbButton
            variant="ghost"
            icon="tag"
            :to="wpath('/settings?tab=labels')"
          >
            Labels
          </NbButton>
          <NbButton
            variant="ghost"
            icon="lightning"
            :to="wpath('/settings?tab=automation')"
          >
            Automation
          </NbButton>
        </div>
      </NbPanel>

      <!-- Archive is the reversible step, delete is for good. -->
      <NbPanel class="space-settings__section">
        <header>
          <h2 class="type-heading-01">Archive or delete</h2>
          <p class="space-settings__lede">
            Archiving takes the space out of the rail and Home and keeps
            everything in it. Deleting is for good, and only an admin can do it:
            an empty space goes at once, one with cards is archived first and
            deleted from Archived spaces on Home, where its contents are spelled
            out.
          </p>
        </header>
        <div class="space-settings__actions">
          <NbButton
            v-if="archived"
            variant="secondary"
            icon="arrow-counter-clockwise"
            @click="restore"
          >
            Restore space
          </NbButton>
          <NbButton
            v-else
            variant="secondary"
            icon="archive"
            @click="actions.archive()"
          >
            Archive space
          </NbButton>
          <NbButton
            v-if="ws.isAdmin.value"
            variant="danger"
            outlined
            icon="trash"
            :disabled="cardCount > 0"
            @click="actions.remove()"
          >
            Delete space
          </NbButton>
        </div>
      </NbPanel>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * A space's own configuration (2026-10-24): the last entry of the space's
 * group in the rail, the fleet's child-level settings. Everything here is a
 * `space_write` op, the same an agent sends over MCP, so the page and the
 * tool configure the same things: name, description, lists, the done window,
 * archive and delete. The key is shown and not edited, because every card
 * key and every link to a card is made from it.
 *
 * Archive and delete are still in the space's "..." menu on the board, and
 * the done window in the Done column's menu, as shortcuts where the work is.
 */
import { computed, ref, watch } from 'vue'
import { useConfirm, useToast } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import type { TSpaceOp } from '@nubisco/acta-shared'
import { useSpaceActions } from '@/composables/useSpaceActions'
import { wpath } from '@/lib/paths'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{ spaceKey: string }>()

const ws = useWorkspace()
const toast = useToast()
const confirm = useConfirm()

/** Worded as what being in the list means, not as the stored value. */
const ROLE_OPTIONS = [
  { label: 'No role', value: 'none' },
  { label: 'Inbox', value: 'inbox' },
  { label: 'To do', value: 'backlog' },
  { label: 'In progress', value: 'active' },
  { label: 'Blocked', value: 'blocked' },
  { label: 'In review', value: 'review' },
  { label: 'Done', value: 'done' },
]

/** The same choices as the Done column's menu. */
const WINDOW_OPTIONS = [
  { label: '1 day', value: '1' },
  { label: '7 days', value: '7' },
  { label: '14 days', value: '14' },
  { label: '30 days', value: '30' },
  { label: '60 days', value: '60' },
  { label: 'Always', value: 'never' },
]

interface IListEntry {
  id: string
  name: string
  role?: string
  items: number
}

const space = computed(
  () =>
    (ws.overview.value?.spaces ?? []).find((s) => s.key === props.spaceKey) ??
    null,
)
const archived = computed(() => space.value?.archived === true)
const lists = computed<IListEntry[]>(() => space.value?.lists ?? [])
const cardCount = computed(() =>
  lists.value.reduce((sum, l) => sum + l.items, 0),
)

const actions = useSpaceActions(() => ({
  spaceKey: props.spaceKey,
  spaceName: space.value?.name ?? props.spaceKey,
}))

// --- name and description ---------------------------------------------------

const name = ref('')
const description = ref('')
const savedDescription = ref('')
const doneWindow = ref<number | null>(14)
const savingDetails = ref(false)

/**
 * The overview carries the name and lists. The description and the done
 * window are on the space read, asked for with one card so it costs nothing.
 */
async function loadDetails(): Promise<void> {
  name.value = space.value?.name ?? ''
  try {
    const { space: meta } = await api.spaceGet(props.spaceKey, {
      limit: '1',
      state: 'all',
    })
    name.value = meta.name
    description.value = meta.description ?? ''
    savedDescription.value = description.value
    doneWindow.value = meta.done_window_days ?? null
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not load the space' })
  }
}
watch(() => props.spaceKey, loadDetails, { immediate: true })

const detailsDirty = computed(
  () =>
    name.value.trim() !== (space.value?.name ?? '') ||
    description.value !== savedDescription.value,
)

/** One op per call, refreshed after, so the rail and Home say the new name. */
async function write(op: TSpaceOp): Promise<void> {
  const { results } = await api.spaceWrite([op])
  if (!results[0]?.ok) throw new Error(String(results[0]?.error ?? 'failed'))
  await ws.refresh()
}

async function saveDetails(): Promise<void> {
  if (!detailsDirty.value || !name.value.trim()) return
  savingDetails.value = true
  try {
    await write({
      op: 'update',
      op_id: newOpId(),
      key: props.spaceKey,
      name: name.value.trim(),
      description: description.value,
    })
    savedDescription.value = description.value
    toast.success('Saved')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not save' })
  } finally {
    savingDetails.value = false
  }
}

// --- lists ------------------------------------------------------------------

const newListName = ref('')
const newListRole = ref<string | number | null>('backlog')

async function listOp(op: TSpaceOp, failure: string): Promise<boolean> {
  try {
    await write(op)
    return true
  } catch (err) {
    toast.error(humanise(err), { title: failure })
    await ws.refresh()
    return false
  }
}

async function renameList(list: IListEntry, next: string): Promise<void> {
  const trimmed = next.trim()
  if (!trimmed || trimmed === list.name) return
  await listOp(
    {
      op: 'list_update',
      op_id: newOpId(),
      space: props.spaceKey,
      list: list.id,
      name: trimmed,
    },
    'Could not rename the list',
  )
}

async function setRole(list: IListEntry, role: string): Promise<void> {
  if (role === (list.role ?? 'none')) return
  await listOp(
    {
      op: 'list_update',
      op_id: newOpId(),
      space: props.spaceKey,
      list: list.id,
      role: role as 'none',
    },
    'Could not change the role',
  )
}

/**
 * The overview does not carry positions, so every list is given its new
 * place times 1024, the spacing lists are made with, in one batch. A space
 * has a handful of lists, so writing them all costs nothing and leaves no
 * two with the same position.
 */
async function reorder(next: IListEntry[]): Promise<void> {
  if (next.every((l, i) => l.id === lists.value[i]?.id)) return
  const ops: TSpaceOp[] = next.map((l, i) => ({
    op: 'list_update',
    op_id: newOpId(),
    space: props.spaceKey,
    list: l.id,
    pos: (i + 1) * 1024,
  }))
  try {
    const { results } = await api.spaceWrite(ops)
    const failed = results.find((r) => !r.ok)
    if (failed) throw new Error(String(failed.error ?? 'failed'))
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not move the list' })
  }
  await ws.refresh()
}

async function archiveList(list: IListEntry): Promise<void> {
  if (list.items > 0) return
  if (
    await listOp(
      {
        op: 'list_archive',
        op_id: newOpId(),
        space: props.spaceKey,
        list: list.id,
      },
      'Could not archive the list',
    )
  )
    toast.success(`${list.name} archived.`)
}

async function addList(): Promise<void> {
  const listName = newListName.value.trim()
  if (!listName) return
  if (
    await listOp(
      {
        op: 'list_create',
        op_id: newOpId(),
        space: props.spaceKey,
        name: listName,
        role: String(newListRole.value ?? 'none') as 'none',
      },
      'Could not add the list',
    )
  )
    newListName.value = ''
}

// --- done window ------------------------------------------------------------

const doneWindowValue = computed(() =>
  doneWindow.value === null ? 'never' : String(doneWindow.value),
)

async function setDoneWindow(raw: unknown): Promise<void> {
  const days = raw === 'never' || raw === null ? null : Number(raw)
  if (days === doneWindow.value) return
  const previous = doneWindow.value
  doneWindow.value = days
  try {
    await write({
      op: 'update',
      op_id: newOpId(),
      key: props.spaceKey,
      done_window_days: days,
    })
    toast.success(
      days
        ? `Done cards now leave the board after ${days} day${days === 1 ? '' : 's'}.`
        : 'Every done card stays on the board.',
    )
  } catch (err) {
    doneWindow.value = previous
    toast.error(humanise(err), { title: 'Could not change the window' })
  }
}

async function clearDone(): Promise<void> {
  await confirm({
    title: 'Clear the done cards?',
    message:
      'Every card that is done now leaves this board. Nothing is archived: they stay in search, in the Table view under "Done cards" and in their goals.',
    confirmLabel: 'Clear done cards',
    cancelLabel: 'Keep them',
    tone: 'neutral',
    onConfirm: async () => {
      await write({ op: 'clear_done', op_id: newOpId(), key: props.spaceKey })
      toast.success('Done cards cleared.')
    },
    formatError: humanise,
  })
}

// --- archive ----------------------------------------------------------------

async function restore(): Promise<void> {
  try {
    await write({ op: 'restore', op_id: newOpId(), key: props.spaceKey })
    toast.success(`${space.value?.name ?? props.spaceKey} restored.`)
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not restore the space' })
  }
}
</script>

<style scoped lang="scss">
.space-settings {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);
  padding-block-end: var(--nb-spacing-32);

  &__section {
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-16);
  }

  &__form {
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-16);
    max-width: 40rem;
  }

  &__lede {
    max-width: 68ch;
    margin-block-start: var(--nb-spacing-4);
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--nb-spacing-8);
  }

  &__list {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 11rem 5rem auto;
    align-items: center;
    gap: var(--nb-spacing-8);
    width: 100%;
  }

  &__count {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
    text-align: end;
  }

  &__add {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--nb-spacing-8);
  }

  &__done {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--nb-spacing-16);
  }
}

/* A phone: a list's name gets the full width, with its role, count and
   archive button on the line under it. */
@include variables.phone {
  .space-settings__list {
    grid-template-columns: minmax(0, 1fr) auto auto;

    > :first-child {
      grid-column: 1 / -1;
    }
  }
}
</style>
