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

      <NbTree v-else v-model="selected" size="sm" compact>
        <DocsTreeNode v-for="node in tree" :key="node.slug" :node="node" />
      </NbTree>
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
import { computed, onScopeDispose, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NbButton, NbEmptyState, NbSkeleton, NbTree } from '@nubisco/ui'
import { api } from '@/api/client'
import type { IDocTreeNode } from '@/types/docs'
import { useLoadState } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import DocsTreeNode from '@/components/DocsTreeNode.vue'
import NewDocModal from '@/components/NewDocModal.vue'

const route = useRoute()
const router = useRouter()
const ws = useWorkspace()
const load = useLoadState()
const tree = ref<IDocTreeNode[]>([])
const creating = ref(false)

const currentSlug = computed(() => String(route.params.slug ?? ''))
const selected = computed<string | null>({
  get: () => currentSlug.value || null,
  set: (slug) => {
    if (slug) void router.push(`/docs/${slug}`)
  },
})

async function loadTree(): Promise<void> {
  const result = await load.run(api.docTree())
  if (!result) return
  // The API returns a flat depth-ordered list; rebuild the nesting.
  const roots: IDocTreeNode[] = []
  const stack: { node: IDocTreeNode; depth: number }[] = []
  for (const row of result.docs) {
    const node: IDocTreeNode = {
      slug: row.slug,
      title: row.title,
      children: [],
    }
    while (stack.length > 0 && stack[stack.length - 1].depth >= row.depth)
      stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ node, depth: row.depth })
  }
  tree.value = roots
}

void loadTree()
onScopeDispose(
  ws.onLive((event) => {
    if (event.entity === 'doc') void loadTree()
  }),
)

function onCreated(slug: string): void {
  creating.value = false
  void loadTree()
  void router.push(`/docs/${slug}`)
}
</script>

<style scoped lang="scss">
.doc-tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-inline-end: 1px solid var(--nb-c-border);
  padding-inline-end: var(--nb-spacing-16);

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-spacing-8);
    padding-block-end: var(--nb-spacing-8);
  }

  &__title {
    font-size: var(--nb-type-label-md-size);
    font-weight: var(--nb-type-label-md-weight, 600);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--nb-c-text-muted);
  }

  &__body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  &__loading {
    padding: var(--nb-spacing-12) 0;
  }
}
</style>
