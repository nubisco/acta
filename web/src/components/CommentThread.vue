<template>
  <div class="thread">
    <ul ref="listEl" class="thread__list" aria-label="Comments">
      <li
        v-for="comment in comments"
        :key="comment.id"
        :data-comment-id="comment.id"
        :class="{
          'thread__item--active': comment.id === activeId,
          'thread__item--resolved': !!comment.resolved,
        }"
      >
        <div class="thread__head">
          <!-- An avatar on every comment, imported or not. Without one the
               imported half of a thread was a wall of identical bold names
               and there was no way to see at a glance who said what, or
               where one comment ended and the next began. -->
          <ActorAvatar
            :handle="authorHandle(comment)"
            :name="comment.imported?.author"
            :size="24"
          />
          <strong>{{ authorLabel(comment) }}</strong>
          <NbBadge
            v-if="comment.imported?.author"
            v-nb-tooltip="{ body: `Imported from ${comment.imported.source}` }"
            size="sm"
            variant="grey"
          >
            imported
          </NbBadge>
          <!-- Never on an imported comment. The import runs as an agent, so
               every migrated comment claimed to be written by an AI when it
               was written by a person years before Acta existed. The author
               shown is the original one, and the "imported" badge already
               says where it came from. -->
          <NbAiLabel v-if="comment.agent && !comment.imported?.author" />
          <time :datetime="timestampIso(comment)">
            {{ timestampLabel(comment) }}
          </time>
          <!-- Next to the timestamp and in the same voice, because it is the
               same kind of fact: when this text last became what you are
               reading. The tooltip carries the moment, so the line itself
               stays two words. -->
          <span
            v-if="comment.edited"
            v-nb-tooltip="{ body: `Edited ${editedLabel(comment)}` }"
            class="thread__edited"
          >
            (edited)
          </span>
          <NbBadge
            v-if="comment.anchor_status === 'detached'"
            v-nb-tooltip="{
              body: 'The text this comment was on has been changed or removed. The comment is kept.',
            }"
            size="sm"
            variant="orange"
          >
            detached
          </NbBadge>
          <NbBadge v-if="comment.resolved" size="sm" variant="green">
            resolved
          </NbBadge>
          <div class="thread__actions">
            <NbButton
              v-if="resolvable && comment.anchor"
              v-nb-tooltip="{ body: comment.resolved ? 'Reopen' : 'Resolve' }"
              size="xxs"
              variant="ghost"
              :icon="comment.resolved ? 'arrow-counter-clockwise' : 'check'"
              :aria-label="
                comment.resolved ? 'Reopen comment' : 'Resolve comment'
              "
              @click="emit('resolve', comment.id, !comment.resolved)"
            />
            <!-- No trigger at all unless the server said this person may do
                 something with this comment. `can_edit` and `can_delete` are
                 the server's decision: the policy (author-only editing, and a
                 workspace setting for deleting) lives there precisely so it is
                 not guessed at twice. Always visible rather than revealed on
                 hover, because a hover-only control is unreachable on touch,
                 and quiet enough that a long thread does not turn into a
                 column of buttons. -->
            <NbButton
              v-if="comment.can_edit || comment.can_delete"
              v-nb-tooltip="{ body: 'Edit or delete this comment' }"
              class="thread__menu"
              size="xs"
              variant="ghost"
              icon="dots-three"
              :aria-label="`More actions on ${authorLabel(comment)}'s comment`"
              aria-haspopup="menu"
              :aria-expanded="menuFor === comment.id"
              @click="toggleMenu(comment, $event)"
            />
          </div>
        </div>
        <!-- The text an inline comment is about, as it was quoted. Shown
             whether or not it is still in the document, because a detached
             comment only makes sense next to what it was about. -->
        <blockquote
          v-if="comment.anchor"
          class="thread__quote"
          :class="{
            'thread__quote--detached': comment.anchor_status === 'detached',
          }"
        >
          {{ comment.anchor.exact }}
        </blockquote>
        <!-- Editing happens where the comment already is. Moving it into a
             dialog would take the thread away from the person rewriting a
             reply, which is the only thing that tells them whether the
             rewrite still answers anything. -->
        <div
          v-if="editingId === comment.id"
          class="thread__edit"
          @keydown.esc.stop.prevent="cancelEdit"
        >
          <div class="thread__field">
            <!-- A function ref, not a name: a named ref declared inside a
                 v-for is collected into an array, and there is only ever one
                 comment being edited. -->
            <MarkdownEditor
              :ref="(el) => (editor = el as TEditor | null)"
              v-model="editDraft"
              placeholder="Edit this comment... @handle to mention"
            />
          </div>
          <div class="thread__edit-actions">
            <NbButton size="xs" variant="primary" @click="saveEdit(comment.id)">
              Save
            </NbButton>
            <NbButton size="xs" variant="ghost" @click="cancelEdit">
              Cancel
            </NbButton>
          </div>
        </div>
        <MarkdownView
          v-else
          :source="comment.body"
          class="thread__body nb-layer-2"
        />
      </li>
    </ul>
    <NbForm class="thread__composer" @submit.prevent="emit('submit')">
      <div v-if="quote" class="thread__pending">
        <blockquote class="thread__quote">{{ quote }}</blockquote>
        <NbButton
          v-nb-tooltip="{ body: 'Comment on the whole page instead' }"
          size="xxs"
          variant="ghost"
          icon="x"
          aria-label="Stop commenting on this text"
          @click="emit('clear-quote')"
        />
      </div>
      <!-- The box is this element, not the editor. MarkdownEditor has four
           top-level nodes (three teleports and the frame), so it is a
           fragment: Vue drops a fallthrough class and the scoped-style
           attribute on it silently, and the border, the padding and the
           resting height this composer used to declare never reached
           anything. The result read as a caption rather than a field. Its
           root cannot be collapsed to one node without moving the teleports,
           so the wrapper is ours instead. -->
      <div class="thread__field">
        <MarkdownEditor
          ref="composer"
          v-model="draft"
          placeholder="Write a comment... @handle to mention"
        />
      </div>
      <template #footer>
        <NbButton
          type="submit"
          size="xs"
          variant="primary"
          :loading="commenting"
        >
          Comment
        </NbButton>
      </template>
    </NbForm>

    <!-- One menu for the whole thread, positioned against whichever trigger
         was pressed. A menu per row would mount one floating surface per
         comment on a thread that can run to dozens. -->
    <NbMenu
      ref="menu"
      v-model:open="menuOpen"
      size="sm"
      :min-width="MENU_WIDTH"
      @close="closeMenu"
    >
      <NbMenuItem
        v-if="menuComment?.can_edit"
        icon="pencil-simple"
        label="Edit"
        @select="startEdit(menuComment)"
      />
      <NbMenuItem
        v-if="menuComment?.can_delete"
        icon="trash"
        label="Delete"
        danger
        @select="askDelete(menuComment)"
      />
    </NbMenu>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useConfirm, type NbMenu } from '@nubisco/ui'
import { relativeTime } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'

interface ICommentView {
  id: string
  by: string
  agent?: boolean
  ts: number
  body: string
  imported?: { source: string; author?: string; created_at?: string }
  /** Inline comments: the quoted text, kept even once it is detached. */
  anchor?: { exact: string }
  anchor_status?: 'anchored' | 'detached'
  resolved?: { ts: number; by?: string }
  /** When it was last edited. Absent means never edited. */
  edited?: number
  /** The server has decided this person may edit this comment. */
  can_edit?: true
  /** The server has decided this person may delete this comment. */
  can_delete?: true
}

const MENU_WIDTH = 180

/** Imported comments keep their original timestamp, not the import's. */
function timestampIso(comment: ICommentView): string {
  const original = comment.imported?.created_at
  if (original && !Number.isNaN(Date.parse(original)))
    return new Date(original).toISOString()
  return new Date(comment.ts).toISOString()
}

const ws = useWorkspace()
function authorName(handle: string): string {
  return (
    ws.overview.value?.actors.find((a) => a.handle === handle)?.name ??
    `@${handle}`
  )
}

/**
 * An imported comment carries the original author's display name and no
 * handle. Where that name matches a member we use their handle, so the
 * migrated half of a thread shows the same face as the half written here;
 * otherwise the name itself keys the colour, which at least keeps one person
 * one colour throughout.
 */
function authorHandle(comment: ICommentView): string {
  const imported = comment.imported?.author
  if (!imported) return comment.by
  const match = ws.overview.value?.actors.find(
    (a) => a.name.toLowerCase() === imported.toLowerCase(),
  )
  return match?.handle ?? imported
}

function authorLabel(comment: ICommentView): string {
  return comment.imported?.author ?? authorName(comment.by)
}

function timestampLabel(comment: ICommentView): string {
  const original = comment.imported?.created_at
  if (original && !Number.isNaN(Date.parse(original))) {
    return new Date(original).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  }
  return relativeTime(comment.ts)
}

/** The moment of the edit, spelled out, since "(edited)" does not say when. */
function editedLabel(comment: ICommentView): string {
  return new Date(comment.edited ?? 0).toLocaleString()
}

const props = defineProps<{
  comments: ICommentView[]
  modelValue: string
  commenting: boolean
  /** The comment to bring into view and mark, such as a clicked highlight. */
  activeId?: string | null
  /** Text the comment being written will be anchored to. */
  quote?: string | null
  /** Offer resolve and reopen on inline comments. */
  resolvable?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  submit: []
  resolve: [id: string, resolved: boolean]
  'clear-quote': []
  /** A rewritten body, already trimmed and never empty. */
  edit: [id: string, body: string]
  /** Already confirmed by the time this fires. */
  delete: [id: string]
}>()

type TEditor = InstanceType<typeof MarkdownEditor>

const composer = ref<TEditor | null>(null)
const editor = ref<TEditor | null>(null)
const listEl = ref<HTMLElement | null>(null)
const menu = ref<InstanceType<typeof NbMenu> | null>(null)
const confirm = useConfirm()

// Starting an inline comment puts the cursor where the comment is typed.
watch(
  () => props.quote,
  (quote) => {
    if (quote) void nextTick(() => composer.value?.focus())
  },
)

// A clicked highlight brings its comment into view.
watch(
  () => props.activeId,
  (id) => {
    if (!id) return
    void nextTick(() =>
      listEl.value
        ?.querySelector(`[data-comment-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    )
  },
)

const draft = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
})

const menuOpen = ref(false)
const menuFor = ref<string | null>(null)
const menuComment = computed(
  () => props.comments.find((c) => c.id === menuFor.value) ?? null,
)

function toggleMenu(comment: ICommentView, event: MouseEvent): void {
  if (menuFor.value === comment.id && menuOpen.value) {
    closeMenu()
    return
  }
  menuFor.value = comment.id
  const rect = (
    event.currentTarget as HTMLElement | null
  )?.getBoundingClientRect()
  if (rect)
    menu.value?.setPositionXY(
      Math.max(8, rect.right - MENU_WIDTH),
      rect.bottom + 4,
    )
  menuOpen.value = true
}

function closeMenu(): void {
  menuOpen.value = false
  menuFor.value = null
}

const editingId = ref<string | null>(null)
const editDraft = ref('')

function startEdit(comment: ICommentView | null): void {
  if (!comment) return
  closeMenu()
  editingId.value = comment.id
  editDraft.value = comment.body
  void nextTick(() => editor.value?.focus())
}

function cancelEdit(): void {
  editingId.value = null
  editDraft.value = ''
}

/**
 * An empty body is a no-op rather than a save. Emptying the box and pressing
 * Save is the shape of a mistake, and removing a comment is a deliberate act
 * with its own control and its own confirmation.
 */
function saveEdit(id: string): void {
  const body = editDraft.value.trim()
  if (!body) return
  emit('edit', id, body)
  cancelEdit()
}

function askDelete(comment: ICommentView | null): void {
  if (!comment) return
  closeMenu()
  const id = comment.id
  void confirm({
    title: 'Delete comment',
    message:
      'The comment is removed from the thread for everyone. This cannot be undone.',
    subject: comment.body,
    subjectLabel: `Comment by ${authorLabel(comment)}`,
    confirmLabel: 'Delete comment',
    cancelLabel: 'Cancel',
    onConfirm: () => emit('delete', id),
  })
}
</script>

<style scoped lang="scss">
.thread {
  display: grid;
  gap: var(--nb-spacing-12);

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-16);

    /* Each comment on its own surface. Separated only by a gap, a thread of
       long comments ran together into one wall of prose and the sequence was
       impossible to follow; the body is indented under the author so the
       column of avatars is what the eye follows down the thread. */
    > li {
      display: grid;
      gap: var(--nb-spacing-4);
    }
  }

  &__item--active > .thread__body {
    box-shadow: inset 3px 0 0 var(--nb-c-primary);
  }

  &__item--resolved > .thread__body {
    opacity: 0.7;
  }

  /* Everything that acts on the comment, pushed to the end of the head so the
     row reads as "who, when, then what you can do about it". */
  /* Beside the comment's own meta, not pushed to the far edge.
   *
   * This carried `margin-inline-start: auto`, which is harmless in the card
   * inspector and absurd on a document: measured at 1440px, it put the menu
   * 573px from the timestamp it belongs to, a 24x16 target with a 12px glyph,
   * separated from its comment by half a screen of nothing. Jose reported
   * editing a document comment as impossible, and it was: the control was
   * there and unfindable.
   *
   * Right-aligning is the convention, and the convention assumes a column the
   * width of a comment. A document's thread is the width of the page. */
  &__actions {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-2);
    margin-inline-start: var(--nb-spacing-4);
  }

  /* The quoted text an inline comment is about, clipped to three lines. */
  &__quote {
    margin: 0;
    padding-inline-start: var(--nb-spacing-8);
    border-inline-start: 2px solid var(--nb-c-border);
    color: var(--nb-c-text-muted);
    font-size: var(--nb-type-label-sm-size);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__quote--detached {
    font-style: italic;
  }

  &__pending {
    display: flex;
    align-items: flex-start;
    gap: var(--nb-spacing-8);
    margin-block-end: var(--nb-spacing-8);

    .thread__quote {
      flex: 1;
    }
  }

  &__body {
    padding: var(--nb-spacing-8) var(--nb-spacing-12);
    border-radius: var(--nb-radius-sm);
    background: var(--nb-c-surface);
  }

  &__head {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    font-size: var(--nb-type-label-sm-size);
    margin-block-end: var(--nb-spacing-4);

    time {
      color: var(--nb-c-text-subtle);
    }
  }

  &__edited {
    color: var(--nb-c-text-subtle);
    cursor: default;
  }

  &__edit {
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__edit-actions {
    display: flex;
    gap: var(--nb-spacing-8);
  }

  /* What makes a comment box look like one you can type in. The editor is a
     fragment and cannot carry this itself, so the wrapper is the field: a
     boundary that is visible at rest, a surface of its own, a couple of lines
     of resting height, and a focus ring rather than only a colour change,
     which is the same treatment the library's own fields use. */
  &__field {
    border-width: 1px;
    border-style: solid;
    border-color: var(--nb-c-field-border, var(--nb-c-border));
    border-radius: var(--nb-radius-sm);
    padding: var(--nb-spacing-8);
    background: var(--nb-c-surface);

    /* Read by MarkdownEditor's own rule, which is the only way a parent can
       set this: a scoped :deep() selector loses the specificity tie against
       the child's own scoped rule. */
    --md-editor-min-height: 4.5rem;

    &:focus-within {
      border-color: var(--nb-c-primary);
      box-shadow: 0 0 0 2px var(--nb-c-focus-ring);
    }
  }
}
</style>
