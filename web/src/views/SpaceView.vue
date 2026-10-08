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
            ref="filtersButton"
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
          <NbSelect
            id="field-swimlane"
            v-model="swimlane"
            size="sm"
            :options="swimlaneOptions"
            aria-label="Group cards into swimlanes"
          />
          <NbTextInput
            id="field-filter-text"
            v-model="textFilter"
            size="sm"
            placeholder="Filter cards on this space..."
          />
        </div>
      </div>
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
      @open="(key) => inspector.open(key)"
    />

    <CalendarView
      v-else-if="view === 'calendar'"
      :items="items"
      @open="(key) => inspector.open(key)"
    />

    <TimelineView v-else-if="view === 'timeline'" :items="items" />

    <SequenceView
      v-else-if="view === 'sequence'"
      :space-key="spaceKey"
      @open="(key: string) => inspector.open(key)"
    />

    <!-- Columns are capped rather than sharing the width equally. With two
         lists, `1fr` each gave every card half the screen and a space with
         six columns looked nothing like a space with two. A cap means the
         board reads the same either way, and the surplus goes to showing
         MORE of the board rather than to inflating what is already there. -->
    <NbBoard
      v-else
      class="space__board"
      :columns="columns"
      :lanes="lanes"
      :items="spaceItems"
      nestable
      @move="onMove"
      @nest="onNest"
    >
      <!-- A lane keyed by a person wears their face. The library's own
           label class is kept so the header's type does not change with
           what the lane happens to be grouped by. -->
      <template #lane-header="{ lane }">
        <span class="nb-board__lane-label">
          <ActorChip
            v-if="swimlane === 'assignee' && lane.id"
            :handle="lane.id"
          />
          <template v-else>{{ lane.label }}</template>
        </span>
      </template>
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
        <BoardCard
          :row="item as unknown as ISpaceItemRow"
          :open="inspector.itemKey.value === item.key"
          :arrived="arrivedKey === item.key"
          :tour-step="item.id === firstCardId ? 'space-card' : null"
          @open="inspector.open"
          @expand="openItemModal"
          @menu="openCardMenu"
          @edit="openQuickEdit"
        />
      </template>
    </NbBoard>

    <!-- Anchored to the button that opens it. It lived in the toolbar row
         as a sibling of the tabs, which put a full-width panel beside them
         rather than under anything, and it lived in the side panel before
         that, where it displaced the card you had open. A dropdown belongs
         to its trigger; the width is set for coloured pills and a row of
         faces, not for menu rows. -->
    <NbMenu
      ref="filterMenu"
      v-model:open="filtersOpen"
      :min-width="420"
      :max-width="680"
      @close="filtersOpen = false"
    >
      <SpaceFilterPanel
        id="space-filter-panel"
        :labels="labelFilter"
        :assignees="assigneeFilter"
        :state="stateFilter"
        :goal="goalFilter"
        :label-ids="labelIds"
        :active="filtersActive"
        @update:labels="labelFilter = $event"
        @update:assignees="assigneeFilter = $event"
        @update:state="stateFilter = $event"
        @update:goal="goalFilter = $event"
        @clear="clearFilters"
        @close="filtersOpen = false"
      />
    </NbMenu>

    <CardQuickEdit
      :open="quickEdit.open"
      :field="quickEdit.field"
      :row="quickEditRow"
      :space-key="spaceKey ?? ''"
      :anchor="quickEdit.anchor"
      @close="quickEdit.open = false"
      @saved="loadItems"
    />

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
import { computed, nextTick, onScopeDispose, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useConfirm,
  useShellSlot,
  useToast,
  type IBoardItem,
  type IBoardMoveEvent,
  type IBoardNestEvent,
} from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import type { ISpaceItemRow } from '@/types/api'
import { humanise, useLoadState } from '@/lib/state'
import { useViewCommands } from '@/lib/commands'
import { labelText, labelsById, rowLabels } from '@/lib/labels'
import BoardCard, { type TCardField } from '@/components/BoardCard.vue'
import CardQuickEdit from '@/components/CardQuickEdit.vue'
import { roleColor } from '@/lib/colors'
import { useInspector, useUiState, useWorkspace } from '@/stores/workspace'
import type { NbMenu } from '@nubisco/ui'
import ActorChip from '@/components/ActorChip.vue'
import NewItemModal from '@/components/NewItemModal.vue'
import CalendarView from '@/components/views/CalendarView.vue'
import TableView from '@/components/views/TableView.vue'
import TimelineView from '@/components/views/TimelineView.vue'
import SequenceView from '@/components/views/SequenceView.vue'
import SpaceFilterPanel from '@/components/SpaceFilterPanel.vue'
import { recallBoardFilters, rememberBoardFilters } from '@/lib/boardFilters'

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
const labelCatalogue = computed(() => labelsById(ws.overview.value))
const toast = useToast()
const confirm = useConfirm()
const load = useLoadState()
const filterBar = useShellSlot('fixedbar')
const topbarActions = useShellSlot('topbar-right')

const items = ref<ISpaceItemRow[]>([])
const filtersOpen = ref(false)
const labelFilter = ref<string[]>([])
const assigneeFilter = ref<string[]>([])
const stateFilter = ref('open')
const textFilter = ref('')

/**
 * The goal the space is narrowed to, in the URL rather than component state
 * so a goal's page can link straight to "its cards on this board", and so
 * the link can be shared.
 */
const goalFilter = computed<number | null>({
  get: () => {
    const raw = String(route.query.goal ?? '').replace(/^G-/i, '')
    return /^\d+$/.test(raw) ? Number(raw) : null
  },
  set: (value) => {
    const query = { ...route.query }
    if (value === null) delete query.goal
    else query.goal = String(value)
    void router.replace({ query })
  },
})

/**
 * Each board comes back with the filters it was left with (see
 * lib/boardFilters.ts). Synchronous, so the restored filters are in place
 * before the first load for the board rather than after it.
 */
let filtersFor: string | null = null
watch(
  () => props.spaceKey,
  (space) => {
    if (!space) return
    const recalled = recallBoardFilters(space)
    filtersFor = space
    labelFilter.value = recalled.labels
    assigneeFilter.value = recalled.assignees
    stateFilter.value = recalled.state
    textFilter.value = recalled.text
    // The URL wins: a link to a goal's cards on this board means that goal.
    if (route.query.goal === undefined && recalled.goal !== null)
      goalFilter.value = recalled.goal
  },
  { immediate: true, flush: 'sync' },
)
watch(
  [labelFilter, assigneeFilter, stateFilter, textFilter, goalFilter],
  () => {
    if (!filtersFor || filtersFor !== props.spaceKey) return
    rememberBoardFilters(filtersFor, {
      labels: labelFilter.value,
      assignees: assigneeFilter.value,
      state: stateFilter.value,
      text: textFilter.value,
      goal: goalFilter.value,
    })
  },
)

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

/* An empty slot on a card, opened in place. One menu for the board,
 * pointed at whichever slot was clicked. */
const quickEdit = reactive<{
  open: boolean
  field: TCardField | null
  key: string
  anchor: HTMLElement | null
}>({ open: false, field: null, key: '', anchor: null })
const quickEditRow = computed(
  () => items.value.find((i) => i.key === quickEdit.key) ?? null,
)

function openQuickEdit(
  field: TCardField,
  key: string,
  anchor: HTMLElement,
): void {
  Object.assign(quickEdit, { open: true, field, key, anchor })
}

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
  { id: 'sequence', label: 'Sequence' },
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
    (goalFilter.value !== null ? 1 : 0) +
    (textFilter.value !== '' ? 1 : 0) +
    (stateFilter.value !== 'open' ? 1 : 0),
)

const labelIds = computed(() => labelOptions.value.map((o) => o.value))

// The tour points at a card to explain keys and the details panel, and it
// needs one specific card rather than every card wearing the same id. Null
// when the space is empty, which drops the step rather than anchoring it to
// nothing.
const firstCardId = computed(() => spaceItems.value[0]?.id ?? null)

const filterMenu = ref<InstanceType<typeof NbMenu> | null>(null)
const filtersButton = ref<{ $el: HTMLElement } | null>(null)

/** Opens under its own button, so the panel is attached to what opened it. */
function toggleFilters(): void {
  if (filtersOpen.value) {
    filtersOpen.value = false
    return
  }
  const rect = filtersButton.value?.$el?.getBoundingClientRect()
  if (rect) filterMenu.value?.setPosition(rect)
  filtersOpen.value = true
}

const columns = computed(() =>
  (spaceMeta.value?.lists ?? []).map((list) => ({
    id: list.name,
    label: list.name,
    color: roleColor(list.role),
  })),
)

/**
 * Swimlanes: the same columns, split into horizontal bands.
 *
 * A space of two hundred cards in six lists answers "what is in review" and
 * refuses "what is Ivan carrying", because the one axis is already spent on
 * status. A lane is the second axis, and which one matters is a question only
 * the person looking can answer, so it is a choice rather than a setting.
 */
const swimlane = ref<'none' | 'assignee' | 'label'>('none')
const swimlaneOptions = [
  { label: 'No swimlanes', value: 'none' },
  { label: 'By assignee', value: 'assignee' },
  { label: 'By label', value: 'label' },
]

/** The lane a card belongs to. Null is the catch-all band. */
function laneKeysOf(row: ISpaceItemRow): (string | null)[] {
  if (swimlane.value === 'assignee') {
    const who = row.assignees ?? []
    return who.length > 0 ? who : [null]
  }
  if (swimlane.value === 'label') {
    // By id. Two groups may both list 1.12.0, and keying the lanes by name
    // would pour the affected cards and the fixed ones into one band.
    const labels = rowLabels(row).map((l) => l.id ?? l.name ?? '')
    return labels.length > 0 ? labels : [null]
  }
  return [null]
}

const lanes = computed(() => {
  if (swimlane.value === 'none') return undefined
  const seen = new Set<string>()
  for (const row of items.value) {
    for (const key of laneKeysOf(row)) if (key) seen.add(key)
  }
  const named = [...seen].sort((a, b) => a.localeCompare(b))
  return [
    ...named.map((key) => ({
      id: key,
      // The label is the fallback and the accessible name: the lane header
      // slot draws a person as an ActorChip, and this is what it reads as
      // anywhere the slot is not in play.
      label:
        swimlane.value === 'assignee'
          ? (ws.overview.value?.actors.find((a) => a.handle === key)?.name ??
            `@${key}`)
          : // Qualified, so two lanes that both read 1.12.0 say which is
            // which. Falls back to the key for a lane keyed by a bare name.
            (() => {
              const label = labelCatalogue.value.get(key)
              return label ? labelText(label) : key
            })(),
    })),
    // Last, and only when something lands in it: a permanently empty
    // "Unassigned" band is a row of six empty cells on every space.
    ...(items.value.some((row) => laneKeysOf(row).includes(null))
      ? [
          {
            id: null,
            label: swimlane.value === 'assignee' ? 'Unassigned' : 'No label',
          },
        ]
      : []),
  ]
})

const spaceItems = computed<IBoardItem[]>(() =>
  // Cell order is the array order, so sort by pos before handing over.
  [...items.value]
    .sort((a, b) => a.pos - b.pos)
    // A card with two assignees belongs in both lanes, so it is emitted once
    // per lane with an id that stays unique; the key rides along untouched so
    // every interaction still addresses the real card.
    .flatMap((row) =>
      laneKeysOf(row).map((laneId) => ({
        ...row,
        id: laneId === null ? row.key : `${row.key}@@${laneId}`,
        key: row.key,
        columnId: row.list,
        laneId,
      })),
    ),
)

// No "all" entry: an empty multi-select already means every label, and an
// option that competes with the empty state only creates a second way to say
// the same thing.
const labelOptions = computed(() => [
  ...(ws.overview.value?.labels ?? [])
    .filter((l) => l.space_key === null || l.space_key === spaceKey.value)
    // Valued by id: the server's label filter takes either, and a name
    // would filter on both groups that happen to hold it.
    .map((l) => ({ label: l.name, value: l.id })),
])

async function loadItems(): Promise<void> {
  if (!spaceKey.value) return
  const params: Record<string, string> = {
    state: stateFilter.value,
    limit: '200',
    // What a card shows beyond the row: summary, size, blockers,
    // attachments and goals. The other views ignore what they do not draw.
    detail: 'board',
  }
  if (labelFilter.value.length > 0) params.label = labelFilter.value.join(',')
  if (assigneeFilter.value.length > 0)
    params.assignee = assigneeFilter.value.join(',')
  if (textFilter.value) params.text = textFilter.value
  if (goalFilter.value !== null) params.goal = String(goalFilter.value)
  const result = await load.run(api.spaceGet(spaceKey.value, params))
  if (result) {
    items.value = result.items
    void revealPending()
  }
}

/**
 * Point at the card the reader came here for. Asked for through
 * `revealCard` by the inspector's "Show on its space", and also for a link
 * that lands on the space with a card open. Scrolled to the middle of the
 * board both ways, because the columns scroll sideways as well as down.
 */
const arrivedKey = ref<string | null>(null)
let arrivedTimer: ReturnType<typeof setTimeout> | undefined
let revealOnLoad =
  typeof route.query.item === 'string' ? route.query.item : null

async function revealPending(): Promise<void> {
  const key = ui.revealCard.value?.key ?? revealOnLoad
  if (!key) return
  if (!items.value.some((row) => row.key === key)) {
    // Its own space, and still not here: filtered out or archived.
    if (key.split('-')[0] === spaceKey.value) {
      // Asked for from a card's "Show on board", and hidden by this board's
      // filters: the person asked to see this card, so the filters give way
      // and the reload that follows points at it (Jose, 2026-10-08).
      if (ui.revealCard.value?.key === key && filtersActive.value) {
        clearFilters()
        toast.info(`Filters cleared to show ${key}.`)
        return
      }
      // Otherwise dropped, or it would fire on some later load the reader
      // did not ask about.
      ui.revealCard.value = null
      revealOnLoad = null
    }
    return
  }
  ui.revealCard.value = null
  revealOnLoad = null
  await nextTick()
  const el = document.querySelector<HTMLElement>(
    `[data-card-key="${CSS.escape(key)}"]`,
  )
  if (!el) return
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({
    block: 'center',
    inline: 'center',
    behavior: still ? 'auto' : 'smooth',
  })
  clearTimeout(arrivedTimer)
  arrivedKey.value = null
  await nextTick()
  arrivedKey.value = key
  arrivedTimer = setTimeout(() => (arrivedKey.value = null), 2600)
}

// Already on the card's space: the route does not change, so the request
// is answered from what is loaded.
watch(
  () => ui.revealCard.value,
  (request) => {
    if (request) void revealPending()
  },
)

watch(
  [spaceKey, labelFilter, assigneeFilter, stateFilter, goalFilter],
  loadItems,
  {
    immediate: true,
  },
)

let textDebounce: ReturnType<typeof setTimeout> | undefined
watch(textFilter, () => {
  clearTimeout(textDebounce)
  textDebounce = setTimeout(loadItems, 250)
})

onScopeDispose(
  ws.onLive((event) => {
    // A goal renamed, checked in on or archived changes the goal pill on
    // every card that serves it.
    if (event.entity === 'goal') {
      void loadItems()
      return
    }
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
      // Whether a card serves the goal the space is filtered to.
      'item.goal_linked',
      'item.goal_unlinked',
      'item.parented',
      'item.detached',
      // Not membership, but what a card face shows and a reload is the only
      // way the board learns it.
      'item.sized',
      'item.blocked',
      'item.unblocked',
      'attachment.added',
      'attachment.removed',
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
  goalFilter.value = null
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

/**
 * A card dropped onto another becomes part of it.
 *
 * Not optimistic, unlike a move. A move has an obvious provisional answer to
 * draw (the card, in the new place), and this does not: the server refuses a
 * cycle, and drawing the nesting first would mean drawing a relationship that
 * is about to be taken back. The reload is one request and the refusal is the
 * interesting case.
 */
async function onNest(event: IBoardNestEvent): Promise<void> {
  try {
    const { results } = await api.itemWrite([
      {
        op: 'set_parent',
        op_id: newOpId(),
        key: event.itemId,
        parent: event.ontoItemId,
      },
    ])
    if (!results[0].ok) throw new Error((results[0] as { error: string }).error)
    toast.success(`${event.itemId} is now part of ${event.ontoItemId}`)
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not nest that card' })
  }
  await loadItems()
}
</script>

<style scoped lang="scss">
.space {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;
  /* The view owns the viewport's remaining height so the BOARD scrolls, not
     the page. The library already makes column headers sticky, but sticky is
     relative to the nearest scrolling ancestor: while the page was the
     scroller, the headers stuck to the top of a box that was itself sliding
     away, so a long space scrolled its own titles off screen. */
  min-block-size: 0;

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

  /* The library's default track is minmax(200px, 1fr). The floor is right;
     the ceiling is what makes two columns swallow the window. Set as the
     library's own token so making columns resizable upstream overrides this
     rather than fighting it. */
  &__board {
    --nb-board-column-track: minmax(17rem, 22rem);
    /* Its own scroller, which is what gives the sticky headers something to
       stick to. Sized against the viewport rather than a parent, because the
       toolbar above it grows when the filters open. */
    max-block-size: calc(100dvh - var(--space-chrome, 13rem));
    overflow: auto;
    overscroll-behavior: contain;
  }
}
</style>
