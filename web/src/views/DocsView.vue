<template>
  <div
    ref="docsEl"
    class="docs"
    :class="{
      'docs--wide': isWide,
      'docs--toc-overlay': tocOverlay,
      'docs--toc-side': tocShown && !tocOverlay,
    }"
  >
    <DocsTreeSlot v-if="!chrome.frameHidden.value" />

    <div class="docs__content">
      <component :is="topbarActions.Outlet">
        <template v-if="doc && !editing">
          <NbButton
            size="sm"
            variant="secondary"
            :aria-expanded="showHistory"
            @click="showHistory = !showHistory"
          >
            Version history (v{{ doc.rev }})
          </NbButton>
          <NbButton size="sm" variant="primary" @click="startEdit"
            >Edit</NbButton
          >
          <DocTransferMenu :doc="doc" />
          <NbButton
            v-nb-tooltip="{ body: 'Delete page' }"
            size="sm"
            variant="secondary"
            icon="trash"
            aria-label="Delete page"
            @click="removeDoc"
          />
        </template>
        <template v-else-if="doc && editing">
          <NbButton size="sm" variant="secondary" @click="cancelEdit">
            Cancel
          </NbButton>
          <NbButton
            size="sm"
            variant="primary"
            :loading="saving"
            @click="save()"
          >
            Save changes
          </NbButton>
        </template>
      </component>

      <div v-if="!slug" class="docs__placeholder">
        <NbEmptyState
          title="Select a document"
          description="Pick a page from the Documents panel, or create a new one."
        />
      </div>

      <div v-else-if="load.state.value === 'loading'" class="docs__loading">
        <NbSkeleton variant="heading" label="Loading document" />
        <NbSkeleton variant="text" :lines="8" />
      </div>

      <NbEmptyState
        v-else-if="load.state.value === 'forbidden'"
        kind="forbidden"
        title="You do not have access to this page"
        description="Ask a workspace admin if you think you should."
      />

      <NbEmptyState
        v-else-if="load.state.value === 'error' || !doc"
        kind="error"
        title="Could not load this page"
        :description="load.message.value"
      >
        <template #actions>
          <NbButton variant="secondary" @click="loadDoc">Retry</NbButton>
        </template>
      </NbEmptyState>

      <article v-else class="docs__doc">
        <h1 class="type-heading-04">{{ doc.title }}</h1>
        <ProvenanceNote v-if="doc.imported" :imported="doc.imported" />
        <DocChromeBar
          v-if="!viewingOld"
          :slug="doc.slug"
          :stats="stats"
          :wide="isWide"
          :editing="editing"
          :can-edit="canEdit"
          @update:wide="setWide"
        />

        <NbBanner
          v-if="conflict"
          status="error"
          variant="inline"
          title="This page changed while you were editing"
        >
          Your draft is kept below. Reload to see the newer version, then merge
          by hand.
          <template #action>
            <NbButton size="sm" variant="secondary" @click="reloadKeepDraft">
              Reload page
            </NbButton>
          </template>
        </NbBanner>

        <div v-if="showHistory && doc.versions" class="docs__history">
          <NbDataTable
            :columns="versionColumns"
            :rows="versionRows"
            row-key="rev"
            size="sm"
            aria-label="Version history. Select a version to compare it with the current one."
            @row-click="viewVersion"
          />
          <div v-if="viewingOld" class="docs__history-actions">
            <NbButton size="sm" variant="primary" @click="restoreVersion">
              Restore v{{ viewedVersion }}
            </NbButton>
            <NbButton size="sm" variant="ghost" @click="backToCurrent">
              Back to current
            </NbButton>
          </div>
        </div>

        <MarkdownEditor
          v-if="editing"
          ref="bodyEditor"
          v-model="draft"
          :focus-mode="chrome.prefs.dimBlocks"
          autofocus
          placeholder="Start writing. Headings, lists, quotes and code all form as you type. Drop an image to attach it."
          class="docs__editor"
          :owner="{ doc: doc.slug }"
          commentable
          block-tools
          @attached="reloadAttachments"
          @comment="startInlineComment"
        />
        <template v-else-if="viewingOld">
          <NbBanner
            status="info"
            variant="inline"
            :title="`Comparing v${viewedVersion} (left) with the current v${doc.rev}`"
          />
          <DocDiff :original="viewedBody" :modified="doc.body" />
        </template>
        <MarkdownView
          v-else
          ref="bodyReader"
          :source="doc.body"
          :wide="doc.layout === 'wide'"
          :attachments="doc.attachments"
        />

        <footer
          v-if="doc.backlinks && doc.backlinks.length > 0"
          class="docs__backlinks"
        >
          <h2>Referenced by</h2>
          <NbDefinitionList :items="backlinkFacts" layout="columns" />
        </footer>

        <DocCommentLayer
          v-if="!viewingOld"
          :reader="bodyReader?.$el ?? null"
          :editor="bodyEditor?.editor ?? null"
          :comments="doc.comments ?? []"
          :pending="pendingAnchor"
          :active-id="activeCommentId"
          @compose="startInlineComment"
          @open="activeCommentId = $event"
        />

        <section v-if="!viewingOld" class="docs__comments">
          <h2>
            Comments
            <span v-if="doc.comments && doc.comments.length > 0">
              ({{ doc.comments.length }})
            </span>
          </h2>
          <CommentThread
            v-model="commentDraft"
            :comments="doc.comments ?? []"
            :commenting="commenting"
            :active-id="activeCommentId"
            :quote="pendingAnchor?.exact ?? null"
            resolvable
            @submit="submitComment"
            @resolve="resolveComment"
            @clear-quote="pendingAnchor = null"
          />
        </section>
      </article>
    </div>

    <div v-if="tocShown" class="docs__toc">
      <DocToc
        :source="shownSource"
        :root="bodyRoot"
        :words="stats.words"
        :overlay="tocOverlay"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  watch,
} from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import {
  prefersReducedMotion,
  useConfirm,
  useShellSlot,
  useToast,
} from '@nubisco/ui'
import { useWorkspace } from '@/stores/workspace'
import { useDocChrome } from '@/lib/docChrome'
import { documentOutline, documentStats, tocWorthShowing } from '@/lib/docText'
import { api, newOpId, ApiHttpError } from '@/api/client'
import type { IDocDetail } from '@/types/api'
import { humanise, relativeTime, useLoadState } from '@/lib/state'
import { DOC_NAV_KEY } from '@/lib/keys'
import { useViewCommands } from '@/lib/commands'
import CommentThread from '@/components/CommentThread.vue'
import DocCommentLayer from '@/components/comments/DocCommentLayer.vue'
import type { IAnchor } from '@/lib/anchors'
import DocChromeBar from '@/components/DocChromeBar.vue'
import DocToc from '@/components/DocToc.vue'
import DocsTreeSlot from '@/components/DocsTreeSlot.vue'
import DocTransferMenu from '@/components/DocTransferMenu.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import ProvenanceNote from '@/components/ProvenanceNote.vue'
import { wpath } from '@/lib/paths'
import {
  findLinkedBlock,
  isBlockFragment,
  parseBlockFragment,
} from '@/lib/blockLinks'

// Monaco is heavy; the diff surface loads only when a version is compared.
const DocDiff = defineAsyncComponent(() => import('@/components/DocDiff.vue'))

const props = defineProps<{ slug?: string }>()

const toast = useToast()
const confirm = useConfirm()
const router = useRouter()

// Inside the docs space a doc ref navigates for real; the quick-look modal
// is for every other surface.
provide(
  DOC_NAV_KEY,
  (target: string) => void router.push(wpath(`/docs/${target}`)),
)

useViewCommands('docs', [
  {
    id: 'docs:edit',
    label: 'Edit page',
    icon: 'pencil-simple',
    namespace: 'Docs',
    handler: () => {
      if (doc.value && !editing.value) startEdit()
    },
  },
  {
    id: 'docs:delete',
    label: 'Delete page',
    icon: 'trash',
    namespace: 'Docs',
    handler: removeDoc,
  },
  {
    id: 'docs:history',
    label: 'Version history',
    icon: 'clock-counter-clockwise',
    namespace: 'Docs',
    handler: () => (showHistory.value = !showHistory.value),
  },
])

function removeDoc(): void {
  const current = doc.value
  if (!current) return
  void confirm({
    title: 'Delete page',
    message: `"${current.title}" and its comments, versions and attachments will be permanently deleted. Pages that still have child pages cannot be deleted.`,
    confirmLabel: 'Delete page',
    cancelLabel: 'Cancel',
    onConfirm: async () => {
      try {
        const { results } = await api.docWrite([
          { op: 'delete', op_id: newOpId(), ref: current.slug },
        ])
        if (!results[0].ok) {
          toast.error(String(results[0].error ?? 'Delete failed'), {
            title: 'Delete failed',
          })
          return
        }
        toast.success(`Deleted "${current.title}"`)
        const parent = current.slug.split('/').slice(0, -1).join('/')
        void router.push(parent ? `/docs/${parent}` : '/docs')
      } catch (err) {
        toast.error(humanise(err), { title: 'Delete failed' })
      }
    },
  })
}
const load = useLoadState()
const topbarActions = useShellSlot('topbar-right')

const doc = ref<IDocDetail | null>(null)
const editing = ref(false)
const showHistory = ref(false)
const saving = ref(false)
const conflict = ref(false)
const draft = ref('')
const viewedVersion = ref(0)
const viewedBody = ref('')

const slug = computed(() => props.slug || undefined)
const isDirty = computed(
  () => editing.value && doc.value !== null && draft.value !== doc.value.body,
)
const viewingOld = computed(
  () => doc.value !== null && viewedVersion.value !== doc.value.rev,
)

/*
 * Document chrome: contents, width, focus and stats. All of it reads the
 * markdown and none of it writes to it. Width is the stored `layout`, and
 * focus mode is this viewer's own preference, kept in this browser.
 */
const ws = useWorkspace()
const chrome = useDocChrome()
const canEdit = computed(() => !!ws.me.value?.scopes.includes('write'))
const isWide = computed(() => doc.value?.layout === 'wide')
const shownSource = computed(() =>
  editing.value ? draft.value : (doc.value?.body ?? ''),
)
const stats = computed(() => documentStats(shownSource.value))
const tocShown = computed(
  () =>
    !!doc.value &&
    !viewingOld.value &&
    tocWorthShowing(
      documentOutline(shownSource.value),
      stats.value.words,
      shownSource.value,
    ),
)

function setWide(wide: boolean): void {
  if (doc.value) doc.value.layout = wide ? 'wide' : undefined
}

/**
 * The element the headings render into: the editor's while editing, the
 * reader's otherwise. Derived from the refs the comment layer already holds,
 * because an element can carry only one `ref` and both features need it.
 */
const bodyRoot = computed<HTMLElement | null>(() => {
  if (bodyEditor.value) return bodyEditor.value.root()
  const el = bodyReader.value?.$el
  return el instanceof HTMLElement ? el : null
})

/**
 * Whether the contents have a gutter to sit in beside the page column, or
 * have to float over it. Measured, because the room depends on the rail, the
 * tree and the inspector as much as on the window.
 */
const docsEl = ref<HTMLElement | null>(null)
const docsWidth = ref(Number.POSITIVE_INFINITY)
/*
 * It floats only when the page is genuinely too narrow for text and contents
 * side by side. Below a full gutter on both sides the column gives up the
 * room instead (see `.docs--toc-side`): a 1440px laptop with the document
 * tree open used to reduce the contents to one icon in a corner, which nobody
 * found, while the column held 135px it never filled with prose.
 */
const TOC_RAIL_REM = 12
const COLUMN_MIN_REM = 44
const tocOverlay = computed(() => {
  const rem = parseFloat(
    getComputedStyle(document.documentElement).fontSize || '16',
  )
  return docsWidth.value < (COLUMN_MIN_REM + TOC_RAIL_REM) * rem
})
let resizeObserver: ResizeObserver | null = null
let releaseSurface: (() => void) | null = null
onMounted(() => {
  releaseSurface = chrome.attachSurface()
  if (typeof ResizeObserver === 'undefined' || !docsEl.value) return
  resizeObserver = new ResizeObserver(([entry]) => {
    docsWidth.value = entry.contentRect.width
  })
  resizeObserver.observe(docsEl.value)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  releaseSurface?.()
})

/**
 * Cmd/Ctrl+S saves while editing and keeps the editor open.
 *
 * There was no way to save from the keyboard, and page focus mode hides the
 * topbar the Save button lives in, so somebody writing in focus mode had to
 * leave it to save. Only while editing: a reader pressing it gets the
 * browser's own behaviour. The browser's save dialog is suppressed even when
 * there is nothing to save, because a download prompt in the middle of writing
 * is never what the keystroke meant.
 */
function onSaveShortcut(event: KeyboardEvent): void {
  if (!editing.value) return
  if (event.key.toLowerCase() !== 's') return
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey)
    return
  event.preventDefault()
  if (saving.value || !isDirty.value) return
  void save({ keepEditing: true })
}
onMounted(() => window.addEventListener('keydown', onSaveShortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', onSaveShortcut))

const versionColumns = [
  { key: 'version', header: 'Version' },
  { key: 'by', header: 'By' },
  { key: 'when', header: 'When' },
]

const versionRows = computed(() =>
  (doc.value?.versions ?? []).map((v) => ({
    rev: v.rev,
    version: `v${v.rev}`,
    by: `@${v.handle}`,
    when: relativeTime(v.created_at),
  })),
)

const KIND_TERMS: Record<string, string> = {
  item: 'Card',
  doc: 'Document',
  comment: 'Comment on',
}

/**
 * Who points at this page.
 *
 * The server used to return internal ids and this rendered them verbatim, so
 * the list read "item  itm_01m2gaz92142arwky3srvkw0pd". A backlink nobody can
 * identify is not a backlink. It now shows the key and the title, and falls
 * back to the id only when the source has been deleted out from under it.
 */
const backlinkFacts = computed(() =>
  (doc.value?.backlinks ?? []).map((link) => ({
    term: KIND_TERMS[link.src_kind] ?? link.src_kind,
    value: link.ref
      ? link.label
        ? `${link.ref}: ${link.label}`
        : link.ref
      : link.src_id,
  })),
)

/**
 * Re-read the attachment list after an upload.
 *
 * Only the list: reloading the document would replace the body with what the
 * server has, discarding whatever is being typed. The embed for the new file
 * is already in the draft, and this is what lets it resolve to a picture
 * rather than a broken one.
 */
async function reloadAttachments(): Promise<void> {
  if (!slug.value || !doc.value) return
  try {
    const fresh = await api.docGet(slug.value)
    doc.value = { ...doc.value, attachments: fresh.attachments }
  } catch {
    // The embed still renders once the page is next opened.
  }
}

/**
 * Set while a keyboard save reloads the page, so the reload does not close the
 * editor. The Save button means "save and close", and closing unmounts the
 * editor and loses the caret. A save shortcut that did that would be worse
 * than none. A flag rather than a parameter, because `watch(slug, loadDoc)`
 * calls this with the new slug as its first argument.
 */
let keepEditorOpen = false

async function loadDoc(): Promise<void> {
  if (!slug.value) {
    doc.value = null
    return
  }
  // Read once, before the request: the flag belongs to the save that asked.
  const keepOpen = keepEditorOpen
  try {
    // Not while an editor is open. The loading state swaps the page for a
    // placeholder, which unmounts the editor exactly as closing it would.
    if (!keepOpen) load.state.value = 'loading'
    doc.value = await api.docGet(slug.value, [
      'backlinks',
      'versions',
      'comments',
    ])
    viewedVersion.value = doc.value.rev
    viewedBody.value = doc.value.body
    if (!keepOpen) editing.value = false
    showHistory.value = false
    conflict.value = false
    load.state.value = 'ready'
  } catch (err) {
    // With an editor open, never clear the page: the draft on screen is the
    // only copy of whatever was typed since the save. Let the caller report it.
    if (keepOpen) throw err
    doc.value = null
    load.state.value =
      err instanceof ApiHttpError && err.status === 403 ? 'forbidden' : 'error'
    load.message.value = humanise(err)
  }
}

watch(slug, loadDoc, { immediate: true })

function startEdit(): void {
  draft.value = doc.value?.body ?? ''
  editing.value = true
  conflict.value = false
}

function cancelEdit(): void {
  if (!isDirty.value) {
    editing.value = false
    return
  }
  void confirm({
    title: 'Discard changes',
    message: 'Your edits to this page will be lost.',
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    onConfirm: () => {
      editing.value = false
    },
  })
}

onBeforeRouteLeave(async () => {
  if (!isDirty.value) return true
  let leave = false
  await confirm({
    title: 'Discard changes',
    message: 'Your edits to this page will be lost.',
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    onConfirm: () => {
      leave = true
    },
  })
  return leave
})

async function save(options: { keepEditing?: boolean } = {}): Promise<void> {
  if (!doc.value) return
  saving.value = true
  try {
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
      conflict.value = true
      return
    }
    keepEditorOpen = options.keepEditing === true
    try {
      await loadDoc()
    } finally {
      keepEditorOpen = false
    }
  } catch {
    conflict.value = true
  } finally {
    saving.value = false
  }
}

async function reloadKeepDraft(): Promise<void> {
  const kept = draft.value
  await loadDoc()
  draft.value = kept
  editing.value = true
}

async function viewVersion(row: { rev: number }): Promise<void> {
  if (!doc.value) return
  if (row.rev === doc.value.rev) {
    backToCurrent()
    return
  }
  const old = await api.docGet(doc.value.slug, undefined, row.rev)
  viewedVersion.value = row.rev
  viewedBody.value = old.body
}

function backToCurrent(): void {
  if (!doc.value) return
  viewedVersion.value = doc.value.rev
  viewedBody.value = doc.value.body
}

const commentDraft = ref('')
const commenting = ref(false)

const bodyReader = ref<InstanceType<typeof MarkdownView> | null>(null)
const bodyEditor = ref<InstanceType<typeof MarkdownEditor> | null>(null)
/** The text the comment being written is about, if it is an inline one. */
const pendingAnchor = ref<IAnchor | null>(null)
/** The inline comment whose highlight was last clicked. */
const activeCommentId = ref<string | null>(null)

watch(slug, () => {
  pendingAnchor.value = null
  activeCommentId.value = null
})

function startInlineComment(anchor: IAnchor): void {
  pendingAnchor.value = anchor
  activeCommentId.value = null
}

/*
 * Block links (`#block=...`, made by the editor's grip menu).
 *
 * Followed on the reader once the document has rendered, and again when the
 * fragment changes on a page already open. The block is found by its text,
 * so the link still lands after the page has been edited around it. When the
 * block cannot be found, the page opens at the top and says so, rather than
 * leaving somebody wherever the page happened to load, or guessing.
 *
 * Nothing here writes: the highlight is a class on the rendered element, taken
 * off again, and the reader's HTML is rebuilt from the markdown regardless.
 */
const BLOCK_HIGHLIGHT = 'md__block-target'
const BLOCK_HIGHLIGHT_MS = 2400
let followedBlockLink = ''

function followBlockLink(): void {
  const fragment = window.location.hash
  if (!isBlockFragment(fragment) || !doc.value || editing.value) return
  const key = `${doc.value.slug}|${fragment}`
  if (followedBlockLink === key) return
  const el = bodyReader.value?.$el
  const root =
    el instanceof HTMLElement
      ? (el.querySelector<HTMLElement>('.md') ?? el)
      : null
  if (!root) return
  followedBlockLink = key
  const anchor = parseBlockFragment(fragment)
  const target = anchor ? findLinkedBlock(root, anchor) : null
  if (!target) {
    docsEl.value?.scrollIntoView?.({ block: 'start' })
    toast.warning(
      anchor
        ? 'The linked block has moved or been removed. Showing the top of the page instead.'
        : 'This block link is incomplete, so the top of the page is shown instead.',
      { title: 'Block not found' },
    )
    return
  }
  target.scrollIntoView?.({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'center',
  })
  target.classList.add(BLOCK_HIGHLIGHT)
  window.setTimeout(
    () => target.classList.remove(BLOCK_HIGHLIGHT),
    BLOCK_HIGHLIGHT_MS,
  )
}

watch(
  [() => doc.value?.slug, () => doc.value?.body, bodyReader, editing],
  () => void nextTick(followBlockLink),
  { flush: 'post' },
)

function onHashChange(): void {
  followedBlockLink = ''
  followBlockLink()
}
onMounted(() => window.addEventListener('hashchange', onHashChange))
onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange))

async function resolveComment(id: string, resolved: boolean): Promise<void> {
  if (!doc.value) return
  try {
    const { results } = await api.docWrite([
      {
        op: 'comment_resolve',
        op_id: newOpId(),
        ref: doc.value.slug,
        comment_id: id,
        resolved,
      },
    ])
    if (!results[0].ok) throw new Error((results[0] as { error: string }).error)
    const refreshed = await api.docGet(doc.value.slug, ['comments'])
    doc.value = { ...doc.value, comments: refreshed.comments }
  } catch (err) {
    toast.error(humanise(err), {
      title: resolved ? 'Resolve failed' : 'Reopen failed',
    })
  }
}

async function submitComment(): Promise<void> {
  if (!doc.value || !commentDraft.value.trim()) return
  commenting.value = true
  try {
    const { results } = await api.docWrite([
      {
        op: 'comment',
        op_id: newOpId(),
        ref: doc.value.slug,
        body: commentDraft.value.trim(),
        // Stored with the comment, never written into the document.
        ...(pendingAnchor.value ? { anchor: pendingAnchor.value } : {}),
      },
    ])
    if (!results[0].ok) throw new Error((results[0] as { error: string }).error)
    commentDraft.value = ''
    pendingAnchor.value = null
    const refreshed = await api.docGet(doc.value.slug, [
      'backlinks',
      'versions',
      'comments',
    ])
    doc.value = refreshed
    viewedVersion.value = refreshed.rev
    viewedBody.value = refreshed.body
  } catch (err) {
    toast.error(humanise(err), { title: 'Comment failed' })
  } finally {
    commenting.value = false
  }
}

async function restoreVersion(): Promise<void> {
  if (!doc.value) return
  try {
    const { results } = await api.docWrite([
      {
        op: 'replace',
        op_id: newOpId(),
        ref: doc.value.slug,
        if_rev: doc.value.rev,
        body: viewedBody.value,
      },
    ])
    if (!results[0].ok) throw new Error('conflict')
    toast.success(`Restored v${viewedVersion.value} as v${doc.value.rev + 1}`)
    await loadDoc()
  } catch (err) {
    toast.error(humanise(err), { title: 'Restore failed' })
  }
}
</script>

<style scoped lang="scss">
.docs {
  /* The tree lives in the shell's contextbar; the page itself reads as an
   * isolated column, Confluence-style, instead of running edge to edge. */
  /* The gutters either side of the column are where the contents sit. */
  --docs-column: 52rem;

  display: grid;
  grid-template-columns:
    minmax(0, 1fr) minmax(0, var(--docs-column))
    minmax(0, 1fr);
  min-height: 0;

  /* Contents beside the column. The right track never drops below the rail's
     width, so where both gutters are wide the page stays centred exactly as
     before, and where they are not the column narrows (down to the 44rem
     DocsView.vue's `tocOverlay` guarantees, still wider than a 68ch line)
     rather than the contents collapsing into a corner button. */
  &--toc-side {
    grid-template-columns:
      minmax(0, 1fr) minmax(0, var(--docs-column))
      minmax(12rem, 1fr);
  }

  /* The document's stored `layout`. */
  &--wide {
    --docs-column: 72rem;
  }

  &__content {
    grid-column: 2;
    grid-row: 1;
    display: grid;
    gap: var(--nb-spacing-16);
    align-content: start;
    min-width: 0;
    width: 100%;
  }

  &__toc {
    grid-column: 3;
    grid-row: 1;
    align-self: start;
    position: sticky;
    inset-block-start: var(--nb-spacing-16);
    max-inline-size: 16rem;
    padding-inline-start: var(--nb-spacing-24);
  }

  /* No gutter wide enough: the contents float at the column's edge instead,
   * and the column keeps a strip clear so the button never sits on text. */
  &--toc-overlay &__toc {
    grid-column: 2;
    justify-self: end;
    inline-size: 0;
    padding: 0;
    z-index: 1;
  }

  &--toc-overlay:has(.docs__toc) &__content {
    padding-inline-end: var(--nb-spacing-32);
  }

  &__placeholder {
    min-height: 24rem;
    padding-block: var(--nb-spacing-24);
  }

  &__loading {
    display: grid;
    gap: var(--nb-spacing-12);
  }

  &__doc {
    display: grid;
    gap: var(--nb-spacing-16);

    h1 {
      margin: 0;
    }
  }

  &__history {
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__history-actions {
    display: flex;
    gap: var(--nb-spacing-8);
  }

  &__editor {
    min-block-size: 24rem;
  }

  /* A contents link lands with the heading clear of the top edge. */
  &__doc :deep(:is(h1, h2, h3, h4, h5, h6)) {
    scroll-margin-block-start: var(--nb-spacing-24);
  }

  /* A wide page is wide for prose too, not only for tables and diagrams. */
  &--wide &__doc :deep(.md-prose :is(p, li, blockquote)) {
    max-width: none;
  }

  /* Focus mode's block dimming. The editor extension marks the root and the
   * caret's block (editor/focusMode.ts), this decides what that looks like. */
  &__doc :deep(.acta-focus-mode > *) {
    transition: opacity 160ms ease;
  }

  &__doc :deep(.acta-focus-mode > :not(.acta-focus-current)) {
    opacity: 0.3;
  }

  @media (prefers-reduced-motion: reduce) {
    &__doc :deep(.acta-focus-mode > *) {
      transition: none;
    }
  }

  &__backlinks {
    border-block-start: 1px solid var(--nb-c-border);
    padding-block-start: var(--nb-spacing-16);

    h2 {
      margin: 0 0 var(--nb-spacing-8);
      font-size: var(--nb-type-heading-01-size);
    }
  }

  &__comments {
    border-block-start: 1px solid var(--nb-c-border);
    margin-block-start: var(--nb-spacing-24);
    padding-block-start: var(--nb-spacing-24);
    max-inline-size: 46rem;

    h2 {
      margin: 0 0 var(--nb-spacing-12);
      font-size: var(--nb-type-heading-01-size);

      span {
        color: var(--nb-c-text-subtle);
        font-weight: 400;
      }
    }
  }
}
</style>
