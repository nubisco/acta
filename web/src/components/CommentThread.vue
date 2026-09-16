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
          <NbButton
            v-if="resolvable && comment.anchor"
            v-nb-tooltip="{ body: comment.resolved ? 'Reopen' : 'Resolve' }"
            class="thread__resolve"
            size="xxs"
            variant="ghost"
            :icon="comment.resolved ? 'arrow-counter-clockwise' : 'check'"
            :aria-label="
              comment.resolved ? 'Reopen comment' : 'Resolve comment'
            "
            @click="emit('resolve', comment.id, !comment.resolved)"
          />
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
        <MarkdownView :source="comment.body" class="thread__body nb-layer-2" />
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
      <MarkdownEditor
        ref="composer"
        v-model="draft"
        placeholder="Write a comment... @handle to mention"
        class="thread__editor"
      />
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
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
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
}

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
}>()

const composer = ref<InstanceType<typeof MarkdownEditor> | null>(null)
const listEl = ref<HTMLElement | null>(null)

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

  &__resolve {
    margin-inline-start: auto;
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

  &__editor {
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    padding: var(--nb-spacing-8);

    :deep(.tiptap) {
      min-block-size: 3rem;
    }

    &:focus-within {
      border-color: var(--nb-c-primary);
    }
  }
}
</style>
