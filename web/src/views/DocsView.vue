<template>
  <div class="docs">
    <aside class="docs__tree">
      <header>
        <h2>Docs</h2>
        <NbButton
          variant="ghost"
          size="sm"
          icon="plus"
          aria-label="New doc"
          @click="creating = true"
        />
      </header>
      <ul>
        <li
          v-for="node in tree"
          :key="node.slug"
          :style="{ paddingLeft: `${node.depth * 14}px` }"
          :class="{ 'docs__node--active': node.slug === slug }"
        >
          <router-link :to="`/docs/${node.slug}`">{{ node.title }}</router-link>
        </li>
      </ul>
      <NbEmptyState
        v-if="tree.length === 0"
        title="No docs yet"
        description="Create the first page."
      />
    </aside>

    <article v-if="doc" class="docs__doc">
      <header class="docs__doc-header">
        <h1>{{ doc.title }}</h1>
        <div class="docs__doc-actions">
          <NbButton
            v-if="!editing"
            variant="ghost"
            size="sm"
            @click="showHistory = !showHistory"
          >
            v{{ doc.rev }}
          </NbButton>
          <NbButton
            v-if="!editing"
            variant="primary"
            size="sm"
            @click="startEdit"
            >Edit</NbButton
          >
          <template v-else>
            <NbButton variant="ghost" size="sm" @click="editing = false"
              >Cancel</NbButton
            >
            <NbButton variant="primary" size="sm" @click="save">Save</NbButton>
          </template>
        </div>
      </header>

      <div v-if="showHistory && doc.versions" class="docs__history">
        <button
          v-for="version in doc.versions"
          :key="version.rev"
          type="button"
          :class="{ 'docs__version--current': version.rev === viewedVersion }"
          @click="viewVersion(version.rev)"
        >
          v{{ version.rev }} · @{{ version.handle }} ·
          {{ new Date(version.created_at).toLocaleString() }}
        </button>
        <NbButton
          v-if="viewedVersion !== doc.rev"
          size="sm"
          variant="primary"
          @click="restoreVersion"
        >
          Restore v{{ viewedVersion }}
        </NbButton>
      </div>

      <div v-if="editing" class="docs__editor">
        <textarea v-model="draft" rows="24" />
        <MarkdownView
          class="docs__preview"
          :source="draft"
          :wide="doc.layout === 'wide'"
        />
      </div>
      <MarkdownView v-else :source="viewedBody" :wide="doc.layout === 'wide'" />

      <footer
        v-if="doc.backlinks && doc.backlinks.length > 0"
        class="docs__backlinks"
      >
        <h3>Referenced by</h3>
        <ul>
          <li
            v-for="link in doc.backlinks"
            :key="`${link.src_kind}-${link.src_id}`"
          >
            {{ link.src_kind }} {{ link.src_id }}
          </li>
        </ul>
      </footer>
    </article>

    <NbEmptyState
      v-else
      class="docs__empty"
      title="Select a document"
      description="Pick a page from the tree, or create a new one."
    />

    <TextPromptModal
      :open="creating"
      title="New document"
      :fields="[
        { name: 'title', label: 'Title', placeholder: 'Decision log' },
        {
          name: 'parent',
          label: 'Parent slug (optional)',
          optional: true,
          initial: slug ?? '',
        },
      ]"
      @close="creating = false"
      @submit="createDoc"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NbButton, NbEmptyState, useToast } from '@nubisco/ui'
import { api, newOpId, type IDocDetail, type IDocNode } from '@/api/client'
import { slugify } from '@nubisco/acta-shared'
import MarkdownView from '@/components/MarkdownView.vue'
import TextPromptModal from '@/components/TextPromptModal.vue'

const props = defineProps<{ slug?: string }>()

const router = useRouter()
const toast = useToast()
const tree = ref<IDocNode[]>([])
const doc = ref<IDocDetail | null>(null)
const editing = ref(false)
const creating = ref(false)
const showHistory = ref(false)
const draft = ref('')
const viewedVersion = ref(0)
const viewedBody = ref('')

const slug = computed(() => props.slug || undefined)

async function loadTree(): Promise<void> {
  tree.value = (await api.docTree()).docs
}

async function loadDoc(): Promise<void> {
  if (!slug.value) {
    doc.value = null
    return
  }
  try {
    doc.value = await api.docGet(slug.value, ['backlinks', 'versions'])
    viewedVersion.value = doc.value.rev
    viewedBody.value = doc.value.body
    editing.value = false
    showHistory.value = false
  } catch {
    doc.value = null
  }
}

watch(slug, loadDoc, { immediate: true })
void loadTree()

function startEdit(): void {
  draft.value = doc.value?.body ?? ''
  editing.value = true
}

async function save(): Promise<void> {
  if (!doc.value) return
  const { results } = await api.docWrite([
    {
      op: 'replace',
      op_id: newOpId(),
      ref: doc.value.slug,
      if_rev: doc.value.rev,
      body: draft.value,
    },
  ])
  if (!results[0].ok) {
    toast.error(
      'The document changed while you edited; showing the latest version',
      { title: 'Conflict' },
    )
  }
  await loadDoc()
}

async function viewVersion(rev: number): Promise<void> {
  if (!doc.value) return
  const old = await api.docGet(doc.value.slug, undefined, rev)
  viewedVersion.value = rev
  viewedBody.value = old.body
}

async function restoreVersion(): Promise<void> {
  if (!doc.value) return
  const { results } = await api.docWrite([
    {
      op: 'replace',
      op_id: newOpId(),
      ref: doc.value.slug,
      if_rev: doc.value.rev,
      body: viewedBody.value,
    },
  ])
  if (results[0].ok)
    toast.success(`Restored v${viewedVersion.value} as v${doc.value.rev + 1}`)
  await loadDoc()
}

async function createDoc(values: Record<string, string>): Promise<void> {
  creating.value = false
  const base = slugify(values.title)
  const parent = values.parent?.trim() || undefined
  const docSlug = parent ? `${parent}/${base}` : base
  const { results } = await api.docWrite([
    {
      op: 'create',
      op_id: newOpId(),
      slug: docSlug,
      title: values.title,
      parent,
      body: '',
      layout: 'default',
      tags: [],
    },
  ])
  if (results[0].ok) {
    await loadTree()
    void router.push(`/docs/${docSlug}`)
  } else {
    toast.error(String((results[0] as { error: string }).error))
  }
}
</script>

<style scoped lang="scss">
.docs {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: calc(var(--nb-base-unit) * 3);
  align-items: start;
  min-height: 100%;

  &__tree {
    position: sticky;
    top: 0;

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;

      h2 {
        margin: 0;
        font-size: 1rem;
      }
    }

    ul {
      list-style: none;
      margin: var(--nb-base-unit) 0 0;
      padding: 0;
      display: grid;
      gap: 2px;
    }

    a {
      display: block;
      padding: 4px 8px;
      border-radius: 6px;
      color: inherit;
      text-decoration: none;
      font-size: 0.9rem;

      &:hover {
        background: color-mix(in srgb, currentColor 8%, transparent);
      }
    }
  }

  &__node--active a {
    background: color-mix(in srgb, var(--nb-c-primary) 12%, transparent);
    color: var(--nb-c-primary);
  }

  &__doc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-base-unit);

    h1 {
      margin: 0;
    }
  }

  &__doc-actions {
    display: flex;
    gap: calc(var(--nb-base-unit) / 2);
  }

  &__history {
    display: grid;
    gap: 4px;
    margin: var(--nb-base-unit) 0;
    justify-items: start;

    button {
      all: unset;
      cursor: pointer;
      font-size: 0.85rem;
      opacity: 0.8;

      &:hover {
        opacity: 1;
      }
    }
  }

  &__version--current {
    font-weight: 600;
  }

  &__editor {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: calc(var(--nb-base-unit) * 2);
    align-items: start;

    textarea {
      width: 100%;
      font-family: var(--nb-font-mono, monospace);
      font-size: 0.9rem;
      padding: var(--nb-base-unit);
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
      background: transparent;
      color: inherit;
      resize: vertical;
      box-sizing: border-box;
    }
  }

  &__backlinks {
    margin-top: calc(var(--nb-base-unit) * 4);
    font-size: 0.85rem;
    opacity: 0.8;

    ul {
      list-style: none;
      padding: 0;
    }
  }

  &__empty {
    align-self: center;
  }
}
</style>
