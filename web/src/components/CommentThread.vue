<template>
  <div class="thread">
    <ul class="thread__list" aria-label="Comments">
      <li v-for="comment in comments" :key="comment.id">
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
        </div>
        <MarkdownView :source="comment.body" class="thread__body nb-layer-2" />
      </li>
    </ul>
    <NbForm class="thread__composer" @submit.prevent="emit('submit')">
      <MarkdownEditor
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
import { computed } from 'vue'
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
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  submit: []
}>()

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
