<template>
  <div class="space">
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
        {{ stateFilter === 'archived' ? 'Back to space' : 'Archived' }}
      </NbButton>
      <NbButton size="sm" variant="primary" icon="plus" @click="openNewItem()">
        Add item
      </NbButton>
    </component>

    <component :is="filterBar.Outlet">
      <div class="space__bar">
        <NbTabs
          v-model="view"
          v-nb-tour-step="'space-views'"
          variant="line"
          :items="viewTabs"
          aria-label="Space views"
        />
        <div
          v-nb-tour-step="'space-filters'"
          class="space__filters"
          role="search"
          aria-label="Filter items"
        >
          <!-- One control instead of three. Given a toolbar's width none of
               them could show what they held, so labels lost their colour and
               people were limited to one at a time; the panel has room to show
               both. The count is on the button because a collapsed filter that
               does not say it is active is how you end up staring at a space
               that is missing cards. -->
          <NbButton
            size="sm"
            :variant="filtersOpen || filterCount > 0 ? 'secondary' : 'ghost'"
            icon="funnel"
            :aria-pressed="filtersOpen"
            aria-controls="space-filter-panel"
            @click="toggleFilters"
          >
            Filters
            <NbBadge v-if="filterCount > 0" size="sm" variant="primary">
              {{ filterCount }}
            </NbBadge>
          </NbButton>
          <NbTextInput
            id="field-filter-text"
            v-model="textFilter"
            size="sm"
            placeholder="Filter cards on this space..."
          />
        </div>
      </div>
    </component>

    <!-- Claims the same region the card details use, and the two are mutually
         exclusive below: one side panel, one thing in it. -->
    <component :is="inspectorSlot.Outlet">
      <SpaceFilterPanel
        v-if="filtersOpen"
        id="space-filter-panel"
        :labels="labelFilter"
        :assignees="assigneeFilter"
        :state="stateFilter"
        :label-names="labelNames"
        :active="filtersActive"
        @update:labels="labelFilter = $event"
        @update:assignees="assigneeFilter = $event"
        @update:state="stateFilter = $event"
        @clear="clearFilters"
        @close="filtersOpen = false"
      />
    </component>

    <div v-if="load.state.value === 'loading'" class="space__skeleton">
      <NbSkeleton
        v-for="index in 4"
        :key="index"
        variant="block"
        height="14rem"
        :label="index === 1 ? 'Loading space' : undefined"
      />
    </div>

    <NbEmptyState
      v-else-if="load.state.value === 'error'"
      kind="error"
      title="Could not load this space"
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
      description="Items exist on this space, but none match the current filters."
    >
      <template #actions>
        <NbButton variant="secondary" @click="clearFilters">
          Clear filters
        </NbButton>
      </template>
    </NbEmptyState>

    <div v-else-if="items.length === 0" class="space__empty">
      <NbEmptyState
        title="No items yet"
        description="Items move across this space's lists as work progresses."
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

    <NbBoard v-else :columns="columns" :items="spaceItems" @move="onMove">
      <template #column-footer="{ column }">
        <NbButton
          size="sm"
          variant="ghost"
          icon="plus"
          class="space__col-add"
          @click="openNewItem(String(column.id))"
        >
          Add item
        </NbButton>
      </template>
      <template #card="{ item }">
        <button
          class="space__card"
          :class="{
            'space__card--open': inspector.itemKey.value === item.key,
          }"
          :data-nb-tour-step="item.id === firstCardId ? 'space-card' : null"
          type="button"
          :aria-current="
            inspector.itemKey.value === item.key ? 'true' : undefined
          "
          @click="inspector.open(String(item.key))"
          @dblclick="openItemModal(String(item.key))"
          @contextmenu.prevent="openCardMenu($event, String(item.key))"
        >
          <span class="space__card-title">
            <s v-if="item.done">{{ item.title }}</s>
            <template v-else>{{ item.title }}</template>
          </span>
          <span class="space__card-meta">
            <span class="space__card-key">{{ item.key }}</span>
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
              class="space__card-chip"
              :aria-label="`Checklist ${item.chk}`"
            >
              <NbIcon name="check-square" /> {{ item.chk }}
            </span>
            <span
              v-if="item.cmts"
              class="space__card-chip"
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
      :space-key="spaceKey"
      :lists="spaceMeta?.lists ?? []"
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
import type { ISpaceItemRow } from '@/types/api'
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
import SpaceFilterPanel from '@/components/SpaceFilterPanel.vue'

const props = defineProps<{ spaceKey?: string }>()

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
const inspectorSlot = useShellSlot('inspector')
const topbarActions = useShellSlot('topbar-right')

const items = ref<ISpaceItemRow[]>([])
const filtersOpen = ref(false)
const labelFilter = ref<string[]>([])
const assigneeFilter = ref<string[]>([])
const stateFilter = ref('open')
const textFilter = ref('')

/* The new-item modal, and which list it creates into: a column footer names
 * its own column, the topbar button leaves it to the modal's backlog default. */
// --- card context menu ------------------------------------------------------
// Right-click is how a space is worked in Trello and Jira, and it is the only
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

const spaceKey = computed(() => props.spaceKey ?? '')
const spaceMeta = computed(() =>
  ws.overview.value?.spaces.find((b) => b.key === spaceKey.value),
)
const filtersActive = computed(() => filterCount.value > 0)

/** How many filters are narrowing the space, for the toolbar button's badge.
 *  Each chosen label and each chosen person counts, because "3" should mean
 *  three things are excluded rather than three controls are in use. */
const filterCount = computed(
  () =>
    labelFilter.value.length +
    assigneeFilter.value.length +
    (textFilter.value !== '' ? 1 : 0) +
    (stateFilter.value !== 'open' ? 1 : 0),
)

const labelNames = computed(() => labelOptions.value.map((o) => o.value))

// The tour points at a card to explain keys and the details panel, and it
// needs one specific card rather than every card wearing the same id. Null
// when the space is empty, which drops the step rather than anchoring it to
// nothing.
const firstCardId = computed(() => spaceItems.value[0]?.id ?? null)

/** The side panel holds one thing at a time, so opening filters puts the card
 *  details away rather than stacking underneath them. */
function toggleFilters(): void {
  filtersOpen.value = !filtersOpen.value
  if (filtersOpen.value) inspector.close()
}

// The other direction, watched rather than added to each caller: cards open
// from a click, the context menu, after creating one, and from a deep link on
// load, and a rule enforced in four places is a rule that holds in three.
watch(
  () => inspector.itemKey.value,
  (key) => {
    if (key) filtersOpen.value = false
  },
)

const columns = computed(() =>
  (spaceMeta.value?.lists ?? []).map((list) => ({
    id: list.name,
    label: list.name,
    color: roleColor(list.role),
  })),
)

const spaceItems = computed<IBoardItem[]>(() =>
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
    .filter((l) => l.space_key === null || l.space_key === spaceKey.value)
    .map((l) => ({ label: l.name, value: l.name })),
])

async function loadItems(): Promise<void> {
  if (!spaceKey.value) return
  const params: Record<string, string> = {
    state: stateFilter.value,
    limit: '200',
  }
  if (labelFilter.value.length > 0) params.label = labelFilter.value.join(',')
  if (assigneeFilter.value.length > 0)
    params.assignee = assigneeFilter.value.join(',')
  if (textFilter.value) params.text = textFilter.value
  const result = await load.run(api.spaceGet(spaceKey.value, params))
  if (result) items.value = result.items
}

watch([spaceKey, labelFilter, assigneeFilter, stateFilter], loadItems, {
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
    // because the space already shows it: a drag applies the move locally,
    // and reloading mid-drag would fight the pointer.
    //
    // The exception is anything that changes whether a card still belongs in
    // the current filter. Archiving from the inspector left the card sitting
    // on the space until a manual refresh, which reads as the action having
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

useViewCommands('space', [
  {
    id: 'space:add-card',
    label: 'Add card',
    icon: 'plus',
    namespace: 'Space',
    handler: () => openNewItem(),
  },
  {
    id: 'space:toggle-archived',
    label: 'Toggle archived cards',
    icon: 'archive',
    namespace: 'Space',
    handler: toggleArchived,
  },
])

function clearFilters(): void {
  labelFilter.value = []
  assigneeFilter.value = []
  textFilter.value = ''
  stateFilter.value = 'open'
}

/**
 * Fractional position between the drop's neighbors, so a move writes one
 * row and never renumbers the list.
 */
function posBetween(
  before: ISpaceItemRow | undefined,
  after: ISpaceItemRow | undefined,
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
.space {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  /* Trello-parity column width: fixed-ish tracks, space scrolls
   * horizontally instead of stretching a few columns across the screen. */
  --nb-space-column-track: minmax(272px, 340px);

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

  /* Which card the details panel is showing. Without it the panel could be
     describing any of them, and "close" had nothing visible to undo. An
     inline-start bar rather than a background tint: cards already carry
     label colour, and a second tint underneath muddied it. */
  &__card--open {
    position: relative;

    &::before {
      content: '';
      position: absolute;
      inset-block: 0;
      inset-inline-start: calc(var(--nb-spacing-8) * -1);
      inline-size: 2px;
      border-radius: 1px;
      background: var(--nb-c-primary);
    }
  }

  /* Cards are a dense list. At 16px they matched the inspector's title, which
   * flattened the hierarchy between "the space" and "the card you opened". */
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
