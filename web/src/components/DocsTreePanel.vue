<template>
  <aside class="doc-tree" aria-label="Documents">
    <header class="doc-tree__head">
      <span class="doc-tree__title">Documents</span>
      <NbButton
        v-nb-tooltip="{ body: 'New document' }"
        size="xs"
        variant="secondary"
        icon="plus"
        aria-label="New document"
        @click="creating = true"
      />
    </header>

    <div class="doc-tree__body">
      <div v-if="load.state.value === 'loading'" class="doc-tree__loading">
        <NbSkeleton variant="text" :lines="6" label="Loading documents" />
      </div>

      <NbEmptyState
        v-else-if="load.state.value === 'error'"
        size="sm"
        kind="error"
        title="Could not load documents"
        :description="load.message.value"
      >
        <template #actions>
          <NbButton size="xs" variant="secondary" @click="loadTree">
            Retry
          </NbButton>
        </template>
      </NbEmptyState>

      <NbEmptyState
        v-else-if="tree.length === 0"
        size="sm"
        :icon="null"
        title="No documents yet"
        description="Pages form a tree; create the first one."
      >
        <template #actions>
          <NbButton size="xs" variant="primary" @click="creating = true">
            Create document
          </NbButton>
        </template>
      </NbEmptyState>

      <div
        v-else
        ref="treeEl"
        class="doc-tree__tree"
        @dragstart.capture="onDragStart"
        @dragover.capture="guardDragOver"
        @dragend="endDrag"
      >
        <NbTree
          ref="treeRef"
          v-model="selected"
          size="sm"
          compact
          :draggable="canWrite"
          @drop="onTreeDrop"
        >
          <DocsTreeNode v-for="node in tree" :key="node.slug" :node="node" />
        </NbTree>
        <div
          v-if="dragSource"
          class="doc-tree__root-drop"
          :class="{ 'doc-tree__root-drop--over': overRoot }"
          data-testid="doc-tree-root-drop"
          @dragover.prevent="overRoot = true"
          @dragleave="overRoot = false"
          @drop.prevent="onRootDrop"
        >
          Drop here to move to the top level
        </div>
      </div>
    </div>
  </aside>

  <NewDocModal
    :open="creating"
    :parent="currentSlug"
    @close="creating = false"
    @created="onCreated"
  />
</template>

<script setup lang="ts">
// The documents tree lives on the LEFT of the docs view (the Confluence
// mental model), leaving the shell inspector free for item details opened
// from inside a page.
import { computed, nextTick, onScopeDispose, ref, toRaw, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToast, type NbTree } from '@nubisco/ui'
import type { ITreeDropEvent } from '@nubisco/ui/components/Tree'
import { api, newOpId } from '@/api/client'
import type { IDocTreeNode } from '@/types/docs'
import { humanise, useLoadState } from '@/lib/state'
import { useViewCommands } from '@/lib/commands'
import { useWorkspace } from '@/stores/workspace'
import DocsTreeNode from '@/components/DocsTreeNode.vue'
import NewDocModal from '@/components/NewDocModal.vue'
import { wpath } from '@/lib/paths'
import {
  ancestorsOf,
  findTitle,
  nestDocs,
  planMove,
  type IMovePlan,
  type TMovePlacement,
} from '@/lib/docTreeMove'

const route = useRoute()
const router = useRouter()
const ws = useWorkspace()
const toast = useToast()
const load = useLoadState()
const tree = ref<IDocTreeNode[]>([])
const creating = ref(false)

const currentSlug = computed(() => String(route.params.slug ?? ''))
const treeRef = ref<InstanceType<typeof NbTree> | null>(null)
const treeEl = ref<HTMLElement | null>(null)

/** Only people who can write may reorganise, so readers get no drag at all. */
const canWrite = computed(() => !!ws.me.value?.scopes.includes('write'))

// Landing on a doc (deep link, breadcrumb, in-page ref) must show WHERE it
// lives: expand its ancestor chain so the selected node is actually visible,
// then bring it into the panel's viewport. The chain comes from the tree, not
// from the slug. A moved page keeps its slug, so after a move the slug no
// longer spells out where the page is.
watch(
  [currentSlug, tree],
  async () => {
    const slug = currentSlug.value
    if (!slug || tree.value.length === 0) return
    treeRef.value?.expandIds(ancestorsOf(tree.value, slug))
    await nextTick()
    document
      .querySelector('.doc-tree [aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  },
  { immediate: true, flush: 'post' },
)
const selected = computed<string | null>({
  get: () => currentSlug.value || null,
  set: (slug) => {
    if (slug) void router.push(wpath(`/docs/${slug}`))
  },
})

async function loadTree(): Promise<void> {
  // A refresh behind a tree already on screen stays quiet. Going back through
  // "loading" swaps the tree for a skeleton and remounts it, which collapses
  // every expanded branch, and a live event follows every move.
  if (load.state.value === 'ready' && tree.value.length > 0) {
    const result = await api.docTree().catch(() => null)
    if (result) tree.value = nestDocs(result.docs)
    return
  }
  const result = await load.run(api.docTree())
  if (!result) return
  tree.value = nestDocs(result.docs)
}

/*
 * Drag and drop. NbTree does the dragging and reports where a node was
 * dropped. What it cannot know is that a page may not go inside itself, so
 * this wrapper answers that during the drag: a dragover anywhere in the
 * dragged node's own subtree is stopped before any node sees it. That leaves
 * no drop indicator there, and since the browser was never told the drop is
 * welcome, no drop either.
 */
const dragSource = ref<string | null>(null)
const overRoot = ref(false)
let dragEl: Element | null = null

function onDragStart(event: DragEvent): void {
  if (!canWrite.value) return
  const node = (event.target as Element | null)?.closest?.(
    'li[role="treeitem"]',
  ) as HTMLElement | null
  if (!node?.dataset.slug) return
  dragEl = node
  dragSource.value = node.dataset.slug
  // NbTreeNode (@nubisco/ui 5.3.0) lets `dragstart` bubble, so every ancestor
  // row runs its own handler after the dragged one and the tree ends up
  // dragging the outermost ancestor: grabbing "Icon System" moved all of
  // "Nubisco Home". Registered now, during capture, this runs on the dragged
  // row just after the node's own handler and stops the event there. Remove
  // it once the library stops the propagation itself.
  node.addEventListener('dragstart', (e) => e.stopPropagation(), {
    once: true,
  })
}

function guardDragOver(event: DragEvent): void {
  if (!dragEl) return
  const node = (event.target as Element | null)?.closest?.(
    'li[role="treeitem"]',
  )
  if (!node || !dragEl.contains(node)) return
  event.stopPropagation()
  // An ancestor's row contains the dragged node, so moving from that row into
  // the dragged subtree is not a "leave" as far as the ancestor can tell, and
  // its indicator would stay lit over a place the page cannot go.
  treeEl.value
    ?.querySelectorAll(
      '.nb-tree-node--drop-before, .nb-tree-node--drop-after, .nb-tree-node--drop-inside',
    )
    .forEach((el) => el.dispatchEvent(new Event('dragleave')))
}

function endDrag(): void {
  dragEl = null
  dragSource.value = null
  overRoot.value = false
}

function onTreeDrop(event: ITreeDropEvent): void {
  commitMove(event.sourceId, { kind: event.position, target: event.targetId })
}

function onRootDrop(): void {
  const source = dragSource.value
  if (source) commitMove(source, { kind: 'root' })
}

function commitMove(source: string, placement: TMovePlacement): void {
  endDrag()
  if (!canWrite.value) return
  const plan = planMove(tree.value, source, placement, newOpId())
  if (!plan) return
  // Once the drop has finished dispatching. The dragged node re-renders
  // somewhere else, and the drag's own `dragend` must still find it where it
  // was so the tree clears its drag state.
  setTimeout(() => void applyMove(source, plan), 0)
}

async function applyMove(source: string, plan: IMovePlan): Promise<void> {
  const previous = toRaw(tree.value)
  const title = findTitle(previous, source)
  tree.value = plan.tree
  treeRef.value?.expandIds(ancestorsOf(plan.tree, source))
  await nextTick()
  Array.from(treeEl.value?.querySelectorAll<HTMLElement>('li[data-slug]') ?? [])
    .find((el) => el.dataset.slug === source)
    ?.scrollIntoView?.({ block: 'nearest' })

  let failure: string | null = null
  try {
    const { results } = await api.docWrite([plan.op])
    if (!results[0]?.ok)
      failure = String(results[0]?.error ?? 'The move was refused')
  } catch (err) {
    failure = humanise(err)
  }
  if (failure === null) return
  // Put it back, unless a live refresh has already replaced the tree.
  if (toRaw(tree.value) === plan.tree) tree.value = previous
  toast.error(failure, { title: `Could not move "${title}"` })
}

useViewCommands('docs', [
  {
    id: 'docs:new',
    label: 'New document',
    icon: 'plus',
    namespace: 'Docs',
    handler: () => {
      creating.value = true
    },
  },
])

void loadTree()
onScopeDispose(
  ws.onLive((event) => {
    if (event.entity === 'doc') void loadTree()
  }),
)

function onCreated(slug: string): void {
  creating.value = false
  void loadTree()
  void router.push(wpath(`/docs/${slug}`))
}
</script>

<style scoped lang="scss">
/*
 * A page with no subpages shows no expand caret.
 *
 * Every row is given NbTreeNode's children slot, because the library only
 * accepts a drop *inside* a row that has one, and a page must be droppable
 * into a page with no subpages yet. The same library draws its caret for any
 * slot, so a leaf's caret is hidden here, keeping its space so labels stay
 * aligned. Remove this once @nubisco/ui separates "can accept children" from
 * "has children".
 */
:deep([data-leaf='true'] .nb-tree-node__toggle-icon) {
  visibility: hidden;
}

.doc-tree {
  /* Placement, width and scrolling belong to the shell's contextbar; the
   * panel only lays out its own header and tree. */
  display: flex;
  flex-direction: column;
  min-height: 100%;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-spacing-8);
    padding-block-end: var(--nb-spacing-8);
  }

  &__title {
    font-size: var(--nb-type-label-md-size);
    font-weight: var(--nb-type-label-md-weight);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--nb-c-text-muted);
  }

  &__body {
    flex: 1;
    min-height: 0;
  }

  /* Only there while a page is being dragged, so a short tree still has
   * somewhere obvious to drop a page at the top level. */
  &__root-drop {
    margin-block-start: var(--nb-spacing-8);
    padding: var(--nb-spacing-12);
    border: 1px dashed var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-muted);
    text-align: center;

    &--over {
      border-color: var(--nb-c-primary);
      color: var(--nb-c-text);
    }
  }

  &__loading {
    padding: var(--nb-spacing-12) 0;
  }
}
</style>
