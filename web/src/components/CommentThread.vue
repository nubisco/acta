<template>
  <div class="thread">
    <ul class="thread__list" aria-label="Comments">
      <li v-for="comment in comments" :key="comment.id">
        <div class="thread__head">
          <ActorAvatar :handle="comment.by" />
          <strong>@{{ comment.by }}</strong>
          <NbAiLabel v-if="comment.agent" />
          <time :datetime="new Date(comment.ts).toISOString()">
            {{ relativeTime(comment.ts) }}
          </time>
        </div>
        <MarkdownView :source="comment.body" />
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
import { NbAiLabel, NbButton, NbForm } from '@nubisco/ui'
import { relativeTime } from '@/lib/state'
import ActorAvatar from '@/components/ActorAvatar.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'

interface ICommentView {
  id: string
  by: string
  agent?: boolean
  ts: number
  body: string
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
    gap: var(--nb-spacing-12);
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
    border-radius: var(--nb-radius-sm, 8px);
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
