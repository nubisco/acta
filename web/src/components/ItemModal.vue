<template>
  <NbModal
    :open="open"
    size="lg"
    :title="it.item.value?.key ?? 'Item'"
    @close="emit('close')"
  >
    <div v-if="it.viewState.value === 'loading'" class="item-modal__loading">
      <NbSkeleton variant="heading" label="Loading item" />
      <NbSkeleton variant="text" :lines="6" />
    </div>

    <NbEmptyState
      v-else-if="it.viewState.value === 'error'"
      kind="error"
      title="Could not load this item"
      :description="it.loadMessage.value"
    >
      <template #actions>
        <NbButton size="sm" variant="secondary" @click="it.load">
          Retry
        </NbButton>
      </template>
    </NbEmptyState>

    <div v-else-if="it.item.value" class="item-modal">
      <div class="item-modal__main">
        <div class="item-modal__title-row">
          <NbTextInput
            id="field-modal-title"
            v-model="it.draft.title"
            size="lg"
            aria-label="Item title"
            @blur="it.commitTitle"
          />
          <NbBadge
            v-if="it.lifecycle.value"
            :variant="it.lifecycle.value.variant"
            :dot="it.lifecycle.value.dot"
            size="md"
          >
            {{ it.lifecycle.value.text }}
          </NbBadge>
        </div>

        <NbBanner
          v-if="it.saveError.value"
          status="error"
          variant="inline"
          :title="it.saveError.value"
        />

        <section class="item-modal__section">
          <h3>Description</h3>
          <MarkdownEditor
            v-model="it.draft.description"
            placeholder="Describe this item... headings, lists and code all work"
            class="item-modal__editor"
            @blur="it.commitDescription"
          />
        </section>

        <section
          v-for="checklist in it.item.value.checklists ?? []"
          :key="checklist.name"
          class="item-modal__section"
        >
          <h3>
            {{ checklist.name }}
            <span class="item-modal__progress">
              {{ checklist.items.filter((entry) => entry.done).length }}/{{
                checklist.items.length
              }}
            </span>
          </h3>
          <ul class="item-modal__checklist">
            <li v-for="entry in checklist.items" :key="entry.text">
              <NbCheckbox
                :model-value="entry.done"
                :label="entry.text"
                @update:model-value="
                  (done: boolean) =>
                    it.toggleCheck(checklist.name, entry.text, done)
                "
              />
            </li>
          </ul>
        </section>

        <section class="item-modal__section">
          <h3>Comments</h3>
          <CommentThread
            v-model="it.commentDraft.value"
            :comments="it.item.value.comments ?? []"
            :commenting="it.commenting.value"
            @submit="it.addComment"
          />
        </section>
      </div>

      <aside class="item-modal__aside" aria-label="Item properties">
        <NbInlineLoading
          :status="it.save.status.value"
          label="Saving"
          finished-label="Saved"
          error-label="Not saved"
          :dwell="1200"
          reserve-space
        />
        <NbField v-slot="{ id }" label="List">
          <NbSelect
            :id="id"
            v-model="it.draft.list"
            size="sm"
            :options="it.listOptions.value"
            @change="it.commitList"
          />
        </NbField>
        <NbField v-slot="{ id }" label="Due">
          <NbDatePicker
            :id="id"
            v-model="it.draft.due"
            size="sm"
            @change="it.commitDue"
          />
        </NbField>
        <NbField v-slot="{ id }" label="Assignees">
          <NbSelect
            :id="id"
            v-model="it.draft.assignees"
            size="sm"
            multiple
            :options="it.assigneeOptions.value"
            @change="it.commitAssignees"
          />
        </NbField>
        <div v-if="it.draft.assignees.length > 0" class="item-modal__avatars">
          <ActorAvatar
            v-for="handle in it.draft.assignees"
            :key="handle"
            :handle="handle"
          />
        </div>
        <NbField v-slot="{ id }" label="Labels">
          <NbSelect
            :id="id"
            v-model="it.draft.labels"
            size="sm"
            multiple
            :options="it.labelOptions.value"
            @change="it.commitLabels"
          />
        </NbField>
        <div v-if="it.draft.labels.length > 0" class="item-modal__chips">
          <NbBadge
            v-for="label in it.draft.labels"
            :key="label"
            size="sm"
            :variant="variants.get(label) ?? 'grey'"
          >
            {{ label }}
          </NbBadge>
        </div>
        <NbDefinitionList
          v-if="it.linkFacts.value.length > 0"
          :items="it.linkFacts.value"
          layout="stacked"
        />
      </aside>
    </div>

    <template #footer>
      <NbButton
        v-if="it.item.value"
        type="button"
        size="sm"
        variant="ghost"
        outlined
        @click="it.toggle(it.item.value.archived ? 'restore' : 'archive')"
      >
        {{ it.item.value.archived ? 'Restore' : 'Archive' }}
      </NbButton>
      <NbButton
        v-if="it.item.value"
        type="button"
        size="sm"
        :variant="it.item.value.done ? 'secondary' : 'primary'"
        @click="it.toggle(it.item.value.done ? 'reopen' : 'complete')"
      >
        {{ it.item.value.done ? 'Reopen' : 'Complete' }}
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import {
  NbBadge,
  NbBanner,
  NbButton,
  NbCheckbox,
  NbDatePicker,
  NbDefinitionList,
  NbEmptyState,
  NbField,
  NbInlineLoading,
  NbModal,
  NbSelect,
  NbSkeleton,
  NbTextInput,
} from '@nubisco/ui'
import { useItem } from '@/composables/useItem'
import { labelVariants } from '@/lib/labels'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import CommentThread from '@/components/CommentThread.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'

const props = defineProps<{ open: boolean; itemKey: string }>()
const emit = defineEmits<{ close: [] }>()

const ws = useWorkspace()
const it = useItem(toRef(props, 'itemKey'))
const variants = computed(() => labelVariants(ws.overview.value))
</script>

<style scoped lang="scss">
.item-modal {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 16rem;
  gap: var(--nb-spacing-24);
  align-items: start;

  &__loading {
    display: grid;
    gap: var(--nb-spacing-12);
  }

  &__main {
    display: grid;
    gap: var(--nb-spacing-16);
    min-inline-size: 0;
  }

  &__title-row {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-12);
  }

  &__section h3 {
    margin: 0 0 var(--nb-spacing-8);
    font-size: var(--nb-type-label-md-size);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--nb-c-text-muted);
  }

  &__progress {
    margin-inline-start: var(--nb-spacing-4);
    color: var(--nb-c-text-subtle);
    text-transform: none;
    letter-spacing: normal;
  }

  &__editor {
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm, 8px);
    padding: var(--nb-spacing-12);

    &:focus-within {
      border-color: var(--nb-c-primary);
    }
  }

  &__checklist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__aside {
    display: grid;
    gap: var(--nb-spacing-8);
    border-inline-start: 1px solid var(--nb-c-border);
    padding-inline-start: var(--nb-spacing-16);
  }

  &__avatars,
  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--nb-spacing-4);
  }

  @media (max-width: 42rem) {
    grid-template-columns: 1fr;

    &__aside {
      border-inline-start: 0;
      padding-inline-start: 0;
      border-block-start: 1px solid var(--nb-c-border);
      padding-block-start: var(--nb-spacing-16);
    }
  }
}
</style>
