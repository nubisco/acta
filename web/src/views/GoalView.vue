<template>
  <div class="goal-view">
    <NbSkeleton
      v-if="load.state.value === 'loading' && !goal"
      variant="block"
      height="16rem"
      label="Loading goal"
    />

    <NbEmptyState
      v-else-if="load.state.value === 'error' && !goal"
      kind="error"
      :title="notFound ? `There is no G-${number}` : 'Could not load this goal'"
      :description="
        notFound
          ? 'It may have been deleted. Its number is never given to another goal.'
          : load.message.value
      "
    >
      <template #actions>
        <NbButton variant="secondary" :href="wpath('/goals')">
          All goals
        </NbButton>
      </template>
    </NbEmptyState>

    <template v-else-if="goal">
      <component :is="actions.Outlet">
        <NbButton
          v-if="!goal.archived"
          size="sm"
          variant="primary"
          icon="chat-text"
          @click="checkInOpen = true"
        >
          Check in
        </NbButton>
      </component>

      <header class="goal-view__head">
        <nav
          v-if="goal.ancestors.length > 0"
          class="goal-view__ancestors"
          aria-label="Part of"
        >
          <span class="goal-view__muted">Part of</span>
          <template
            v-for="(a, i) in [...goal.ancestors].reverse()"
            :key="a.number"
          >
            <NbIcon v-if="i > 0" name="caret-right" :size="12" />
            <RouterLink :to="wpath(`/goals/${a.number}`)">
              {{ a.key }} {{ a.title }}
            </RouterLink>
          </template>
        </nav>
        <div class="goal-view__titleline">
          <span class="goal-view__key">{{ goal.key }}</span>
          <GoalStatusBadge :status="goal.status" size="md" />
          <NbBadge v-if="goal.archived" variant="grey" size="md">
            Archived
          </NbBadge>
          <NbBadge v-if="goal.overdue" variant="red" size="md" dot>
            Past its date
          </NbBadge>
          <NbBadge v-if="goal.stale" variant="orange" size="md" dot>
            No check-in for a month
          </NbBadge>
          <span class="goal-view__tools">
            <NbButton
              size="sm"
              :variant="goal.following ? 'secondary' : 'ghost'"
              :icon="goal.following ? 'eye-slash' : 'eye'"
              @click="toggleFollow"
            >
              {{ goal.following ? 'Unfollow' : 'Follow' }}
            </NbButton>
            <NbButton
              v-nb-tooltip="{ body: 'Edit goal' }"
              size="sm"
              variant="ghost"
              icon="pencil-simple"
              aria-label="Edit goal"
              @click="editOpen = true"
            />
            <NbButton
              v-if="!goal.archived"
              v-nb-tooltip="{ body: 'Archive this goal' }"
              size="sm"
              variant="ghost"
              icon="archive"
              :aria-label="`Archive ${goal.key}`"
              @click="setArchived(true)"
            />
            <template v-else>
              <NbButton
                v-nb-tooltip="{ body: 'Restore' }"
                size="sm"
                variant="secondary"
                icon="arrow-counter-clockwise"
                :aria-label="`Restore ${goal.key}`"
                @click="setArchived(false)"
              />
              <NbButton
                v-nb-tooltip="{ body: 'Delete permanently' }"
                size="sm"
                variant="danger"
                outlined
                icon="trash"
                :aria-label="`Delete ${goal.key} permanently`"
                @click="confirmDelete"
              />
            </template>
          </span>
        </div>
        <h1 class="type-heading-04 goal-view__title">{{ goal.title }}</h1>
        <NbDefinitionList class="goal-view__facts" layout="auto">
          <NbDefinitionListItem term="Owner">
            <ActorChip v-if="goal.owner" :handle="goal.owner" />
            <span v-else class="goal-view__muted">Nobody yet</span>
          </NbDefinitionListItem>
          <NbDefinitionListItem term="Target">
            <template v-if="goal.target_date">
              {{ goalDate(goal.target_date) }}
              <span class="goal-view__muted">
                ({{ targetLabel(goal.target_date) }})
              </span>
            </template>
            <span v-else class="goal-view__muted">No date</span>
          </NbDefinitionListItem>
          <NbDefinitionListItem v-if="goal.start_date" term="Started">
            {{ goalDate(goal.start_date) }}
          </NbDefinitionListItem>
          <NbDefinitionListItem term="Followers">
            <span v-if="goal.followers.length > 0" class="goal-view__people">
              <ActorAvatar
                v-for="handle in goal.followers"
                :key="handle"
                :handle="handle"
                :size="22"
              />
            </span>
            <span v-else class="goal-view__muted">None</span>
          </NbDefinitionListItem>
        </NbDefinitionList>
      </header>

      <div class="goal-view__grid">
        <div class="goal-view__main">
          <!-- The measured half first, because it is what a goal is checked
               against, and the judgement beside it in the other column. -->
          <NbPanel class="goal-view__panel">
            <h2 class="type-heading-02">Work</h2>
            <GoalProgress
              :progress="goal.progress"
              :elapsed="goal.elapsed"
              detailed
              size="md"
              label="Work done across every card serving this goal"
            />
            <div v-if="goal.metric" class="goal-view__metric">
              <NbProgressBar
                :value="goal.metric.percent"
                :label="goal.metric.name"
                :status="goal.metric.percent >= 100 ? 'finished' : 'active'"
              />
              <p class="goal-view__muted">
                {{ metricValue(goal.metric.current, goal.metric.unit) }} now,
                from
                {{ metricValue(goal.metric.start, goal.metric.unit) }} toward
                {{ metricValue(goal.metric.target, goal.metric.unit) }} ({{
                  goal.metric.percent
                }}%)
              </p>
            </div>
          </NbPanel>

          <NbPanel class="goal-view__panel">
            <div class="goal-view__panel-head">
              <h2 class="type-heading-02">
                Cards
                <span class="goal-view__count">{{ items.length }}</span>
              </h2>
              <span class="goal-view__boards">
                <NbButton
                  v-if="items.length > 0"
                  v-nb-tooltip="{
                    body: asTree
                      ? 'Show the cards as a flat list'
                      : 'Show each card with its parts and what blocks it',
                  }"
                  size="xs"
                  :variant="asTree ? 'secondary' : 'ghost'"
                  icon="tree-structure"
                  :aria-pressed="asTree"
                  @click="setAsTree(!asTree)"
                >
                  Tree
                </NbButton>
                <NbButton
                  v-for="space in spaces"
                  :key="space"
                  size="xs"
                  variant="ghost"
                  icon="kanban"
                  :href="wpath(`/s/${space}?goal=${goal.number}`)"
                >
                  {{ space }}
                </NbButton>
              </span>
            </div>
            <p v-if="items.length === 0" class="goal-view__muted">
              Link the cards that get this goal done. Everything that is part of
              a linked card counts too, on whatever space it lives.
            </p>
            <GoalCardTree
              v-else-if="asTree"
              :items="items"
              @open="(key) => inspector.open(key)"
            />
            <NbDataTable
              v-else
              stack-on-phone
              :columns="cardColumns"
              :rows="items"
              row-key="key"
              size="sm"
              aria-label="Cards serving this goal"
              @row-click="(row) => inspector.open((row as IGoalCard).key)"
            >
              <template #cell-title="{ row }">
                <span class="goal-view__card">
                  <span
                    class="goal-view__key"
                    :class="{ 'goal-view__key--done': (row as IGoalCard).done }"
                  >
                    {{ (row as IGoalCard).key }}
                  </span>
                  <span
                    class="goal-view__card-title goal-view__card-title--wraps"
                  >
                    {{ (row as IGoalCard).title }}
                  </span>
                </span>
              </template>
              <template #cell-where="{ row }">
                <span class="goal-view__muted">
                  {{ (row as IGoalCard).space }} ·
                  {{ (row as IGoalCard).list }}
                </span>
              </template>
              <template #cell-people="{ row }">
                <GoalCardPeople :assignees="(row as IGoalCard).assignees" />
              </template>
              <template #cell-state="{ row }">
                <GoalCardState :card="row as IGoalCard" />
              </template>
              <template #cell-how="{ row }">
                <span v-if="(row as IGoalCard).linked" class="goal-view__muted">
                  Linked
                </span>
                <span v-else class="goal-view__muted">
                  Part of {{ (row as IGoalCard).via }}
                </span>
              </template>
              <template #row-actions="{ row }">
                <NbButton
                  v-if="(row as IGoalCard).linked"
                  v-nb-tooltip="{
                    body: `Unlink ${(row as IGoalCard).key}. The card itself stays.`,
                  }"
                  size="xs"
                  variant="ghost"
                  icon="link-break"
                  :aria-label="`Unlink ${(row as IGoalCard).key} from ${goal.key}`"
                  @click.stop="unlink((row as IGoalCard).key)"
                />
              </template>
            </NbDataTable>
            <GoalCardPicker
              v-if="!goal.archived"
              :goal="goal.number"
              :taken="items.map((i) => i.key)"
              @linked="reload"
            />
          </NbPanel>

          <NbPanel class="goal-view__panel">
            <div class="goal-view__panel-head">
              <h2 class="type-heading-02">
                Sub-goals
                <span class="goal-view__count">{{ goal.children.length }}</span>
              </h2>
              <NbButton
                v-if="!goal.archived"
                size="xs"
                variant="secondary"
                icon="plus"
                @click="ui.newGoal.value = { parent: goal.number }"
              >
                Add sub-goal
              </NbButton>
            </div>
            <p v-if="goal.children.length === 0" class="goal-view__muted">
              Break a large goal into smaller ones. Their work counts toward
              this one, unless they are cancelled.
            </p>
            <ul v-else class="goal-view__children">
              <li v-for="child in goal.children" :key="child.number">
                <RouterLink
                  :to="wpath(`/goals/${child.number}`)"
                  class="goal-view__child"
                >
                  <span class="goal-view__child-head">
                    <span class="goal-view__key">{{ child.key }}</span>
                    <span class="goal-view__card-title">{{ child.title }}</span>
                    <GoalStatusBadge :status="child.status" />
                  </span>
                  <GoalProgress :progress="child.progress" />
                </RouterLink>
              </li>
            </ul>
          </NbPanel>
        </div>

        <aside class="goal-view__side">
          <NbPanel v-if="goal.description.trim()" class="goal-view__panel">
            <h2 class="type-heading-02">Why it matters</h2>
            <MarkdownView :source="goal.description" />
          </NbPanel>

          <NbPanel class="goal-view__panel">
            <div class="goal-view__panel-head">
              <h2 class="type-heading-02">Check-ins</h2>
            </div>
            <p v-if="checkIns.length === 0" class="goal-view__muted">
              Nobody has checked in yet. A check-in is a dated word on where the
              goal stands, and it is how its status changes.
            </p>
            <ol v-else class="goal-view__timeline">
              <li
                v-for="entry in checkIns"
                :key="entry.id"
                class="goal-view__entry"
              >
                <div class="goal-view__entry-head">
                  <ActorChip :handle="entry.by" />
                  <GoalStatusBadge v-if="entry.status" :status="entry.status" />
                  <span
                    class="goal-view__muted"
                    :title="absoluteTime(entry.ts)"
                  >
                    {{ relativeTime(entry.ts) }}
                    <template v-if="entry.edited">(edited)</template>
                  </span>
                  <span class="goal-view__entry-tools">
                    <NbButton
                      v-if="entry.can_edit"
                      v-nb-tooltip="{ body: 'Edit this check-in' }"
                      size="xs"
                      variant="ghost"
                      icon="pencil-simple"
                      aria-label="Edit this check-in"
                      @click="startEdit(entry)"
                    />
                    <NbButton
                      v-if="entry.can_delete"
                      v-nb-tooltip="{ body: 'Delete this check-in' }"
                      size="xs"
                      variant="ghost"
                      icon="trash-simple"
                      aria-label="Delete this check-in"
                      @click="confirmDeleteCheckIn(entry)"
                    />
                  </span>
                </div>
                <p
                  v-if="entry.metric_value !== undefined && goal.metric"
                  class="goal-view__muted"
                >
                  {{ goal.metric.name }}:
                  {{ metricValue(entry.metric_value, goal.metric.unit) }}
                </p>
                <template v-if="editing === entry.id">
                  <div class="goal-view__editor">
                    <MarkdownEditor v-model="editDraft" />
                  </div>
                  <span class="goal-view__edit-actions">
                    <NbButton
                      size="xs"
                      variant="primary"
                      @click="saveEdit(entry)"
                    >
                      Save
                    </NbButton>
                    <NbButton size="xs" variant="ghost" @click="editing = null">
                      Cancel
                    </NbButton>
                  </span>
                </template>
                <MarkdownView v-else-if="entry.body" :source="entry.body" />
              </li>
            </ol>
          </NbPanel>
        </aside>
      </div>

      <GoalCheckInModal
        :open="checkInOpen"
        :goal="goal"
        @close="checkInOpen = false"
        @posted="onPosted"
      />
      <GoalFormModal
        :open="editOpen"
        :goal="goal"
        @close="editOpen = false"
        @saved="onSaved"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * One goal: what it is for, how it is judged, and the work behind it.
 *
 * Two columns on purpose. The work is on one side, measured from the cards;
 * the check-ins are on the other, written by people. Laid side by side they
 * can disagree in plain view, which is the reason to look at a goal at all.
 */
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useConfirm, useShellSlot, useToast } from '@nubisco/ui'
import { api, ApiHttpError, newOpId } from '@/api/client'
import type { IGoalCard, IGoalCheckIn, IGoalDetail } from '@/types/api'
import { absoluteTime, humanise, relativeTime, useLoadState } from '@/lib/state'
import { goalDate, metricValue, targetLabel } from '@/lib/goals'
import { wpath } from '@/lib/paths'
import { useInspector, useUiState, useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import ActorChip from '@/components/ActorChip.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import { useTours } from '@/lib/tours'
import GoalCardPeople from '@/components/goals/GoalCardPeople.vue'
import GoalCardPicker from '@/components/goals/GoalCardPicker.vue'
import GoalCardState from '@/components/goals/GoalCardState.vue'
import GoalCardTree from '@/components/goals/GoalCardTree.vue'
import GoalCheckInModal from '@/components/goals/GoalCheckInModal.vue'
import GoalFormModal from '@/components/goals/GoalFormModal.vue'
import GoalProgress from '@/components/goals/GoalProgress.vue'
import GoalStatusBadge from '@/components/goals/GoalStatusBadge.vue'

const props = defineProps<{ number: number }>()

const ws = useWorkspace()
const ui = useUiState()
const inspector = useInspector()
const tours = useTours()
const router = useRouter()
const toast = useToast()
const confirm = useConfirm()
const load = useLoadState()
const actions = useShellSlot('topbar-right')

const goal = ref<IGoalDetail | null>(null)
const notFound = ref(false)
const checkInOpen = ref(false)
const editOpen = ref(false)
const editing = ref<string | null>(null)
const editDraft = ref('')

/** Indexable for NbDataTable, the way ActivityView's rows are. */
type TCardRow = IGoalCard & Record<string, unknown>
const items = computed(() => (goal.value?.items ?? []) as TCardRow[])
const checkIns = computed(() => goal.value?.check_ins ?? [])

/** Every space the work is on, each a link to its board filtered to this goal. */
const spaces = computed(() => [...new Set(items.value.map((i) => i.space))])

const cardColumns = [
  { key: 'title', header: 'Card', primary: true },
  { key: 'people', header: 'Assignees', width: 110 },
  { key: 'where', header: 'Where', width: 110, phoneMeta: true },
  { key: 'state', header: 'State', width: 90, phoneMeta: true },
  { key: 'how', header: 'Counted as', width: 100 },
]

/**
 * The card list as a flat table or as a tree of parts and blockers. How one
 * person likes to read it, so it is remembered in this browser only.
 */
const TREE_STORAGE_KEY = 'acta:goal-cards-tree'

function loadAsTree(): boolean {
  try {
    return window.localStorage.getItem(TREE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const asTree = ref(loadAsTree())

function setAsTree(value: boolean): void {
  asTree.value = value
  try {
    window.localStorage.setItem(TREE_STORAGE_KEY, value ? '1' : '0')
  } catch {
    // Not remembered, still applied for this visit.
  }
}

async function reload(): Promise<void> {
  notFound.value = false
  // The tree's fields come with every read, so switching to it is instant
  // and needs no second request.
  const result = await load.run(
    api.goalGet([props.number], ['items', 'check_ins', 'tree']),
  )
  if (result) {
    goal.value = result.goals[0] ?? null
    // Arriving at a goal straight from a link counts as opening goals.
    await nextTick()
    void tours.maybeStart('goals')
  }
}

/**
 * Whether the goal does not exist, as opposed to failing to load. Asked of
 * the server directly, because the load state turns a 404 into a sentence,
 * and a missing goal deserves its own: its number is never reused.
 */
async function checkMissing(): Promise<void> {
  try {
    await api.goalGet([props.number])
  } catch (err) {
    notFound.value = err instanceof ApiHttpError && err.status === 404
  }
}

watch(
  () => props.number,
  () => {
    goal.value = null
    void reload()
  },
  { immediate: true },
)

watch(
  () => load.state.value,
  (state) => {
    if (state === 'error' && !goal.value) void checkMissing()
  },
)

let pending: ReturnType<typeof setTimeout> | undefined
onScopeDispose(
  ws.onLive((event) => {
    if (event.entity !== 'goal' && event.entity !== 'item') return
    clearTimeout(pending)
    pending = setTimeout(() => void reload(), 400)
  }),
)

async function write(
  ops: Parameters<typeof api.goalWrite>[0],
  failure: string,
): Promise<boolean> {
  try {
    const { results } = await api.goalWrite(ops)
    const failed = results.find((r) => !r.ok)
    if (failed && !failed.ok) throw new Error(failed.error)
    await reload()
    return true
  } catch (err) {
    toast.error(
      err instanceof ApiHttpError
        ? humanise(err)
        : String((err as Error).message),
      {
        title: failure,
      },
    )
    return false
  }
}

function toggleFollow(): void {
  const g = goal.value
  const me = ws.me.value?.handle
  if (!g || !me) return
  void write(
    [
      {
        op: 'follow',
        op_id: newOpId(),
        goal: g.number,
        ...(g.following ? { remove: [me] } : { add: [me] }),
      },
    ],
    g.following ? 'Could not unfollow' : 'Could not follow',
  )
}

function setArchived(archived: boolean): void {
  const g = goal.value
  if (!g) return
  void write(
    [
      {
        op: archived ? 'archive' : 'restore',
        op_id: newOpId(),
        goal: g.number,
      },
    ],
    archived ? 'Could not archive the goal' : 'Could not restore the goal',
  )
}

function confirmDelete(): void {
  const g = goal.value
  if (!g) return
  void confirm({
    title: 'Delete this goal',
    message:
      'Its check-ins go with it. Its cards and sub-goals stay, and sub-goals become top-level goals. This cannot be undone.',
    subject: `${g.key} ${g.title}`,
    confirmLabel: 'Delete goal',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      if (
        await write(
          [{ op: 'delete', op_id: newOpId(), goal: g.number }],
          'Could not delete the goal',
        )
      ) {
        await ws.refresh()
        void router.push(wpath('/goals'))
      }
    },
  })
}

function unlink(key: string): void {
  const g = goal.value
  if (!g) return
  void write(
    [{ op: 'link', op_id: newOpId(), goal: g.number, remove: [key] }],
    'Could not unlink the card',
  )
}

function startEdit(entry: IGoalCheckIn): void {
  editing.value = entry.id
  editDraft.value = entry.body ?? ''
}

async function saveEdit(entry: IGoalCheckIn): Promise<void> {
  const g = goal.value
  if (!g) return
  if (
    await write(
      [
        {
          op: 'check_in_update',
          op_id: newOpId(),
          goal: g.number,
          check_in_id: entry.id,
          body: editDraft.value,
        },
      ],
      'Could not save the check-in',
    )
  )
    editing.value = null
}

function confirmDeleteCheckIn(entry: IGoalCheckIn): void {
  const g = goal.value
  if (!g) return
  void confirm({
    title: 'Delete this check-in',
    message:
      'The note goes. The goal keeps the status it has now, which is changed only by a new check-in.',
    confirmLabel: 'Delete check-in',
    cancelLabel: 'Keep it',
    onConfirm: () =>
      void write(
        [
          {
            op: 'check_in_delete',
            op_id: newOpId(),
            goal: g.number,
            check_in_id: entry.id,
          },
        ],
        'Could not delete the check-in',
      ),
  })
}

async function onPosted(): Promise<void> {
  checkInOpen.value = false
  await reload()
}

async function onSaved(): Promise<void> {
  editOpen.value = false
  await reload()
}
</script>

<style scoped lang="scss">
.goal-view {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  &__head {
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__ancestors {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--nb-spacing-4);
    font-size: var(--nb-type-body-sm-size);

    a {
      color: var(--nb-c-text-muted);
    }
  }

  &__titleline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__tools {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    margin-inline-start: auto;
  }

  &__title {
    margin: 0;
  }

  &__key {
    flex: none;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);

    &--done {
      text-decoration: line-through;
    }
  }

  &__people {
    display: inline-flex;
    gap: var(--nb-spacing-4);
    flex-wrap: wrap;
  }

  &__muted {
    margin: 0;
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

  /* Uses the width it is given: the work beside the judgement on a wide
     window, stacked when there is no room for two. */
  &__grid {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(18rem, 2fr);
    gap: var(--nb-spacing-16);
    align-items: start;

    @media (max-width: 64rem) {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  &__main,
  &__side {
    display: grid;
    gap: var(--nb-spacing-16);
    min-inline-size: 0;
  }

  &__panel {
    display: grid;
    gap: var(--nb-spacing-12);
    padding: var(--nb-spacing-16);
    min-inline-size: 0;

    h2 {
      margin: 0;
    }
  }

  &__panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-spacing-8);
    flex-wrap: wrap;
  }

  &__count {
    margin-inline-start: var(--nb-spacing-4);
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-label-md-size);
  }

  &__boards {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--nb-spacing-4);
  }

  &__metric {
    display: grid;
    gap: var(--nb-spacing-4);
    padding-block-start: var(--nb-spacing-8);
    border-block-start: 1px solid var(--nb-c-border);
  }

  &__card {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    min-inline-size: 0;
  }

  &__card-title {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    /* In the card table a title on one line held the column at its full
       length, which pushed the table wider than its panel once the
       assignees had a column. Two lines, then the ellipsis. */
    &--wraps {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      white-space: normal;
    }
  }

  &__children {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__child {
    display: grid;
    gap: var(--nb-spacing-4);
    padding: var(--nb-spacing-8);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    color: inherit;
    text-decoration: none;

    &:hover {
      border-color: var(--nb-c-primary);
      background: var(--nb-c-surface-hover);
    }
  }

  &__child-head {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    min-inline-size: 0;
  }

  &__timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
  }

  &__entry {
    display: grid;
    gap: var(--nb-spacing-4);
    padding-block: var(--nb-spacing-12);
    border-block-start: 1px solid var(--nb-c-border);

    &:first-child {
      border-block-start: 0;
      padding-block-start: 0;
    }
  }

  &__entry-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__entry-tools {
    display: inline-flex;
    margin-inline-start: auto;
  }

  &__editor {
    border: 1px solid var(--nb-c-field-border, var(--nb-c-border));
    border-radius: var(--nb-radius-sm);
    padding: var(--nb-spacing-8);
    background: var(--nb-c-surface);
    --md-editor-min-height: 4rem;

    &:focus-within {
      border-color: var(--nb-c-primary);
      box-shadow: 0 0 0 2px var(--nb-c-focus-ring);
    }
  }

  &__edit-actions {
    display: inline-flex;
    gap: var(--nb-spacing-4);
  }
}
</style>
