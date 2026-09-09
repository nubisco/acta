<template>
  <div class="board">
    <!-- Adding lives in the shell topbar (always present) and at the foot of
         every column (adds in place); the title is asked for in the modal, so
         the filter bar is purely filters. -->
    <component :is="topbarActions.Outlet">
      <NbButton
        size="sm"
        :variant="stateFilter === 'archived' ? 'secondary' : 'ghost'"
        icon="archive"
        :aria-pressed="stateFilter === 'archived'"
        @click="toggleArchived"
      >
        {{ stateFilter === 'archived' ? 'Back to board' : 'Archived' }}
      </NbButton>
      <NbButton size="sm" variant="primary" icon="plus" @click="openNewItem()">
        Add item
      </NbButton>
    </component>

    <component :is="filterBar.Outlet">
      <div class="board__bar">
        <NbTabs
          v-model="view"
          variant="line"
          :items="viewTabs"
          aria-label="Board views"
        />
        <div class="board__filters" role="search" aria-label="Filter items">
          <NbSelect
            id="field-filter-label"
            v-model="labelFilter"
            size="sm"
            multiple
            :options="labelOptions"
            placeholder="All labels"
          >
            <template #option="{ option }">
              <LabelBadge :name="String(option.value)" />
            </template>
            <template #value="{ values }">
              <span class="label-values">
                <LabelBadge
                  v-for="name in values"
                  :key="String(name)"
                  :name="String(name)"
                />
              </span>
            </template>
          </NbSelect>
          <NbSelect
            id="field-filter-assignee"
            v-model="assigneeFilter"
            size="sm"
            :options="assigneeOptions"
            placeholder="Assignee"
          />
          <NbSelect
            id="field-filter-state"
            v-model="stateFilter"
            size="sm"
            :options="stateOptions"
          />
          <NbTextInput
            id="field-filter-text"
            v-model="textFilter"
            size="sm"
            placeholder="Filter cards on this board..."
          />
        </div>
      </div>
    </component>

    <div v-if="load.state.value === 'loading'" class="board__skeleton">
      <NbSkeleton
        v-for="index in 4"
        :key="index"
        variant="block"
        height="14rem"
        :label="index === 1 ? 'Loading board' : undefined"
      />
    </div>

    <NbEmptyState
      v-else-if="load.state.value === 'error'"
      kind="error"
      title="Could not load this board"
      :description="load.message.value"
    >
      <template #actions>
        <NbButton variant="secondary" @click="loadItems">Retry</NbButton>
      </template>
    </NbEmptyState>

    <NbEmptyState
      v-else-if="items.length === 0 && filtersActive"
      kind="no-results"
      title="Nothing matches these filters"
      description="Items exist on this board, but none match the current filters."
    >
      <template #actions>
        <NbButton variant="secondary" @click="clearFilters">
          Clear filters
        </NbButton>
      </template>
    </NbEmptyState>

    <div v-else-if="items.length === 0" class="board__empty">
      <NbEmptyState
        title="No items yet"
        description="Items move across this board's lists as work progresses."
      >
        <template #actions>
          <NbButton variant="primary" icon="plus" @click="openNewItem()">
            Add the first item
          </NbButton>
        </template>
      </NbEmptyState>
    </div>

    <TableView
      v-else-if="view === 'table'"
      :items="items"
      :variants="variants"
      @open="(key) => inspector.open(key)"
    />

    <CalendarView
      v-else-if="view === 'calendar'"
      :items="items"
      @open="(key) => inspector.open(key)"
    />

    <TimelineView v-else-if="view === 'timeline'" :items="items" />

    <NbBoard v-else :columns="columns" :items="boardItems" @move="onMove">
      <template #column-footer="{ column }">
        <NbButton
          size="sm"
          variant="ghost"
          icon="plus"
          class="board__col-add"
          @click="openNewItem(String(column.id))"
        >
          Add item
        </NbButton>
      </template>
      <template #card="{ item }">
        <button
          class="board__card"
          type="button"
          @click="inspector.open(String(item.key))"
          @dblclick="openItemModal(String(item.key))"
          @contextmenu.prevent="openCardMenu($event, String(item.key))"
        >
          <span class="board__card-title">
            <s v-if="item.done">{{ item.title }}</s>
            <template v-else>{{ item.title }}</template>
          </span>
          <span class="board__card-meta">
            <span class="board__card-key">{{ item.key }}</span>
            <NbBadge
              v-for="label in (item.labels as string[]) ?? []"
              :key="label"
              size="sm"
              :variant="variants.get(label) ?? 'grey'"
            >
              {{ label }}
            </NbBadge>
            <NbBadge
              v-if="item.due && !item.done && Number(item.due) < Date.now()"
              size="sm"
              variant="orange"
              dot
            >
              Overdue
            </NbBadge>
            <span
              v-if="item.chk"
              class="board__card-chip"
              :aria-label="`Checklist ${item.chk}`"
            >
              <NbIcon name="check-square" /> {{ item.chk }}
            </span>
            <span
              v-if="item.cmts"
              class="board__card-chip"
              :aria-label="`${item.cmts} comments`"
            >
              <NbIcon name="chat-circle" /> {{ item.cmts }}
            </span>
            <ActorAvatar
              v-for="assignee in (item.assignees as string[]) ?? []"
              :key="assignee"
              :handle="assignee"
            />
          </span>
        </button>
      </template>
    </NbBoard>

    <NbMenu
      ref="cardMenu"
      v-model:open="cardMenuOpen"
      size="sm"
      :min-width="220"
      @close="cardMenuOpen = false"
    >
      <NbMenuItem
        icon="arrows-out-simple"
        label="Open"
        @select="runCardAction('open')"
      />
      <NbMenuItem
        icon="arrow-line-up"
        label="Move to top"
        :disabled="menuItem?.atTop"
        @select="runCardAction('top')"
      />
      <NbMenuItem
        icon="arrow-line-down"
        label="Move to bottom"
        :disabled="menuItem?.atBottom"
        @select="runCardAction('bottom')"
      />
      <NbMenuDivider />
      <NbMenuItem
        v-if="menuItem?.row.archived"
        icon="arrow-counter-clockwise"
        label="Restore"
        @select="runCardAction('restore')"
      />
      <NbMenuItem
        v-else
        icon="archive"
        label="Archive"
        @select="runCardAction('archive')"
      />
      <NbMenuItem
        v-if="menuItem?.row.archived"
        icon="trash"
        label="Delete card"
        danger
        @select="runCardAction('delete')"
      />
    </NbMenu>

    <NewItemModal
      :open="newItemOpen"
      :board-key="boardKey"
      :lists="boardMeta?.lists ?? []"
      :list="newItemList"
      @close="newItemOpen = false"
      @created="onItemCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useConfirm,
  useShellSlot,
  useToast,
  type IBoardItem,
  type IBoardMoveEvent,
} from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import type { IBoardItemRow } from '@/types/api'
import { humanise, useLoadState } from '@/lib/state'
import { useViewCommands } from '@/lib/commands'
import { labelVariants } from '@/lib/labels'
import { roleColor } from '@/lib/colors'
import { useInspector, useUiState, useWorkspace } from '@/stores/workspace'
import type { NbMenu } from '@nubisco/ui'
import ActorAvatar from '@/components/ActorAvatar.vue'
import NewItemModal from '@/components/NewItemModal.vue'
import CalendarView from '@/components/views/CalendarView.vue'
import TableView from '@/components/views/TableView.vue'
import TimelineView from '@/components/views/TimelineView.vue'
import LabelBadge from '@/components/LabelBadge.vue'

const props = defineProps<{ boardKey?: string }>()

const route = useRoute()
const router = useRouter()
const ws = useWorkspace()
const inspector = useInspector()
const ui = useUiState()

/* A dblclick always fires the click handler first, which opens the
 * inspector; close it again so the modal stands alone. */
function openItemModal(key: string): void {
  inspector.close()
  ui.itemModalKey.value = key
}
const variants = computed(() => labelVariants(ws.overview.value))
const toast = useToast()
const confirm = useConfirm()
const load = useLoadState()
const filterBar = useShellSlot('fixedbar')
const topbarActions = useShellSlot('topbar-right')

const items = ref<IBoardItemRow[]>([])
const labelFilter = ref<string[]>([])
const assigneeFilter = ref('')
const stateFilter = ref('open')
const textFilter = ref('')

/* The new-item modal, and which list it creates into: a column footer names
 * its own column, the topbar button leaves it to the modal's backlog default. */
// --- card context menu ------------------------------------------------------
// Right-click is how a board is worked in Trello and Jira, and it is the only
// place with room for actions that do not deserve a permanent button.
const cardMenu = ref<InstanceType<typeof NbMenu> | null>(null)
const cardMenuOpen = ref(false)
const menuKey = ref('')

/** The right-clicked card, with the edge tests the menu disables against. */
const menuItem = computed(() => {
  const row = items.value.find((i) => i.key === menuKey.value)
  if (!row) return null
  const column = items.value
    .filter((i) => i.list === row.list)
    .sort((a, b) => a.pos - b.pos)
  return {
    row,
    atTop: column[0]?.key === row.key,
    atBottom: column[column.length - 1]?.key === row.key,
  }
})

function openCardMenu(event: MouseEvent, key: string): void {
  menuKey.value = key
  cardMenu.value?.setPositionXY(event.clientX, event.clientY)
  cardMenuOpen.value = true
}

type TCardAction = 'open' | 'top' | 'bottom' | 'archive' | 'restore' | 'delete'

/**
 * Every menu entry routes through here. A template handler must be a direct
 * call: `@select="helper(fn)"` runs `helper(fn)` when the event fires and
 * throws away whatever it returns, so a helper that returns a closure is
 * silently never invoked.
 */
async function runCardAction(action: TCardAction): Promise<void> {
  const key = menuKey.value
  const row = items.value.find((i) => i.key === key)
  cardMenuOpen.value = false
  if (!row) return

  if (action === 'open') {
    inspector.open(key)
    return
  }
  if (action === 'delete') {
    confirmDeleteCard(key)
    return
  }
  if (action === 'archive' || action === 'restore') {
    const ok = await runOps(
      [{ op: action, op_id: newOpId(), key }],
      `Could not ${action} the card`,
    )
    if (ok && action === 'archive')
      toast.success(
        'Archived. Find it under the archived filter, where it can also be deleted.',
      )
    return
  }

  // Positions are sparse floats, so moving to an edge is arithmetic on the
  // neighbour rather than renumbering the column: half the current first, or
  // a step past the current last.
  const column = items.value
    .filter((i) => i.list === row.list)
    .sort((a, b) => a.pos - b.pos)
  const pos =
    action === 'top'
      ? (column[0]?.pos ?? 1024) / 2
      : (column[column.length - 1]?.pos ?? 0) + 1024
  await runOps(
    [{ op: 'move', op_id: newOpId(), key, list: row.list, pos }],
    'Could not move the card',
  )
}

/** Names what goes with the card, same wording as the inspector. */
function confirmDeleteCard(key: string): void {
  const row = items.value.find((i) => i.key === key)
  if (!row) return
  void confirm({
    title: 'Delete this card',
    message:
      'Its comments, checklists and attachments go too. This cannot be undone.',
    subject: `${row.key} ${row.title}`,
    confirmLabel: 'Delete card',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      if (
        await runOps(
          [{ op: 'delete', op_id: newOpId(), key }],
          'Could not delete the card',
        )
      )
        toast.success('Card deleted.')
    },
  })
}

/** One write path for the menu: apply, surface any failure, reload. */
async function runOps(
  ops: Parameters<typeof api.itemWrite>[0],
  failure: string,
): Promise<boolean> {
  try {
    const { results } = await api.itemWrite(ops)
    if (!results[0].ok) throw new Error((results[0] as { error: string }).error)
    await loadItems()
    return true
  } catch (err) {
    toast.error(humanise(err), { title: failure })
    return false
  }
}

/**
 * Which view is showing. In the query string rather than component state so a
 * link to a timeline stays a timeline, and so the back button steps through
 * views the way it steps through anything else.
 */
const viewTabs = [
  { id: 'board', label: 'Board' },
  { id: 'table', label: 'Table' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'timeline', label: 'Timeline' },
]

const view = computed({
  get: () => {
    const wanted = String(route.query.view ?? 'board')
    return viewTabs.some((t) => t.id === wanted) ? wanted : 'board'
  },
  set: (value: string) => {
    const query = { ...route.query }
    if (value === 'board') delete query.view
    else query.view = value
    void router.replace({ query })
  },
})

const newItemOpen = ref(false)
const newItemList = ref<string | undefined>(undefined)

function openNewItem(list?: string): void {
  newItemList.value = list
  newItemOpen.value = true
}

async function onItemCreated(key: string): Promise<void> {
  newItemOpen.value = false
  await loadItems()
  await ws.refresh()
  // Carry straight on: the item exists, the inspector is where the rest of
  // it (labels, assignees, description) gets filled in.
  if (key) inspector.open(key)
}

const boardKey = computed(() => props.boardKey ?? '')
const boardMeta = computed(() =>
  ws.overview.value?.boards.find((b) => b.key === boardKey.value),
)
const filtersActive = computed(
  () =>
    labelFilter.value.length > 0 ||
    assigneeFilter.value !== '' ||
    textFilter.value !== '' ||
    stateFilter.value !== 'open',
)

const columns = computed(() =>
  (boardMeta.value?.lists ?? []).map((list) => ({
    id: list.name,
    label: list.name,
    color: roleColor(list.role),
  })),
)

const boardItems = computed<IBoardItem[]>(() =>
  // Cell order is the array order, so sort by pos before handing over.
  [...items.value]
    .sort((a, b) => a.pos - b.pos)
    .map((row) => ({ id: row.key, columnId: row.list, ...row })),
)

// No "all" entry: an empty multi-select already means every label, and an
// option that competes with the empty state only creates a second way to say
// the same thing.
const labelOptions = computed(() => [
  ...(ws.overview.value?.labels ?? [])
    .filter((l) => l.board_key === null || l.board_key === boardKey.value)
    .map((l) => ({ label: l.name, value: l.name })),
])

const assigneeOptions = computed(() => [
  { label: 'Anyone', value: '' },
  ...(ws.overview.value?.actors ?? [])
    .filter((a) => a.kind === 'human')
    .map((a) => ({ label: `@${a.handle}`, value: a.handle })),
])

const stateOptions = [
  { label: 'Open', value: 'open' },
  { label: 'Done', value: 'done' },
  { label: 'Archived', value: 'archived' },
  { label: 'All', value: 'all' },
]

async function loadItems(): Promise<void> {
  if (!boardKey.value) return
  const params: Record<string, string> = {
    state: stateFilter.value,
    limit: '200',
  }
  if (labelFilter.value.length > 0) params.label = labelFilter.value.join(',')
  if (assigneeFilter.value) params.assignee = assigneeFilter.value
  if (textFilter.value) params.text = textFilter.value
  const result = await load.run(api.boardGet(boardKey.value, params))
  if (result) items.value = result.items
}

watch([boardKey, labelFilter, assigneeFilter, stateFilter], loadItems, {
  immediate: true,
})

let textDebounce: ReturnType<typeof setTimeout> | undefined
watch(textFilter, () => {
  clearTimeout(textDebounce)
  textDebounce = setTimeout(loadItems, 250)
})

onScopeDispose(
  ws.onLive((event) => {
    if (event.entity !== 'item') return
    // Someone else's change always needs a reload. Our own usually does not,
    // because the board already shows it: a drag applies the move locally,
    // and reloading mid-drag would fight the pointer.
    //
    // The exception is anything that changes whether a card still belongs in
    // the current filter. Archiving from the inspector left the card sitting
    // on the board until a manual refresh, which reads as the action having
    // failed.
    const changesMembership = new Set([
      'item.archived',
      'item.restored',
      'item.deleted',
      'item.completed',
      'item.reopened',
      'item.labeled',
      'item.assigned',
      'item.created',
      'item.updated',
    ])
    if (event.actor_kind !== 'human' || changesMembership.has(event.verb))
      void loadItems()
  }),
)

function toggleArchived(): void {
  stateFilter.value = stateFilter.value === 'archived' ? 'open' : 'archived'
}

useViewCommands('board', [
  {
    id: 'board:add-card',
    label: 'Add card',
    icon: 'plus',
    namespace: 'Board',
    handler: () => openNewItem(),
  },
  {
    id: 'board:toggle-archived',
    label: 'Toggle archived cards',
    icon: 'archive',
    namespace: 'Board',
    handler: toggleArchived,
  },
])

function clearFilters(): void {
  labelFilter.value = []
  assigneeFilter.value = ''
  textFilter.value = ''
  stateFilter.value = 'open'
}

/**
 * Fractional position between the drop's neighbors, so a move writes one
 * row and never renumbers the list.
 */
function posBetween(
  before: IBoardItemRow | undefined,
  after: IBoardItemRow | undefined,
): number {
  if (before && after) return (before.pos + after.pos) / 2
  if (before) return before.pos + 1024
  if (after) return after.pos / 2
  return 1024
}

async function onMove(event: IBoardMoveEvent): Promise<void> {
  const row = items.value.find((r) => r.key === event.itemId)
  if (!row) return
  const cell = items.value
    .filter((r) => r.list === event.toColumnId && r.key !== row.key)
    .sort((a, b) => a.pos - b.pos)
  const before = event.beforeItemId
    ? cell.find((r) => r.key === event.beforeItemId)
    : undefined
  const after = event.afterItemId
    ? cell.find((r) => r.key === event.afterItemId)
    : undefined
  const previousList = row.list
  const previousPos = row.pos
  row.list = event.toColumnId
  row.pos = posBetween(before, after)
  try {
    const { results } = await api.itemWrite([
      {
        op: 'move',
        op_id: newOpId(),
        key: row.key,
        list: event.toColumnId,
        pos: row.pos,
      },
    ])
    if (!results[0].ok) throw new Error((results[0] as { error: string }).error)
  } catch (err) {
    row.list = previousList
    row.pos = previousPos
    toast.error(humanise(err), { title: 'Move failed' })
  }
  await loadItems()
}
</script>

<style scoped lang="scss">
.board {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  /* Trello-parity column width: fixed-ish tracks, board scrolls
   * horizontally instead of stretching a few columns across the screen. */
  --nb-board-column-track: minmax(272px, 340px);

  &__views {
    margin-block-end: var(--nb-spacing-4);
  }

  /* Views first, then the filters that apply to whichever is showing. Both
   * left-aligned on their own rows: sharing one row let the filters drift to
   * the right edge and wrap. */
  &__bar {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--nb-spacing-4);
    inline-size: 100%;
  }

  &__filters {
    display: flex;
    gap: var(--nb-spacing-12);
    flex-wrap: wrap;
    align-items: center;
    padding-block: var(--nb-spacing-8);

    /* Selects size to their content, so "Open" collapsed to about four
     * characters and the row read as cramped. A floor keeps the controls a
     * consistent size and stops the row reflowing every time a longer label
     * is chosen. */
    > :deep(.nb-select) {
      min-inline-size: 9rem;
    }

    > :deep(.nb-text-input) {
      min-inline-size: 14rem;
    }
  }

  /* Full-width and quiet: present in every column without shouting in any. */
  &__col-add {
    width: 100%;
    justify-content: flex-start;
    color: var(--nb-c-text-muted);
  }

  &__skeleton {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--nb-spacing-16);
  }

  &__empty {
    min-height: 24rem;
    padding-block: var(--nb-spacing-24);
  }

  &__card {
    background: none;
    border: 0;
    padding: 0;
    text-align: start;
    display: grid;
    gap: var(--nb-spacing-4);
    cursor: pointer;
    width: 100%;
    color: inherit;
    font: inherit;

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring, var(--nb-c-primary));
      outline-offset: 2px;
    }
  }

  /* Cards are a dense list. At 16px they matched the inspector's title, which
   * flattened the hierarchy between "the board" and "the card you opened". */
  &__card-title {
    font-size: var(--nb-type-body-md-size);

    font-weight: var(--nb-type-label-lg-weight, 500);
  }

  &__card-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--nb-spacing-4);
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-muted);
  }

  &__card-key {
    font-family: var(--nb-font-family-mono);
    color: var(--nb-c-text-subtle);
  }

  &__card-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-2);
  }
}
</style>
