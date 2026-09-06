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
          <NbInlineEdit
            v-model="it.draft.title"
            label="Item title"
            size="xl"
            class="item-modal__title"
            @commit="it.commitTitle"
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

        <ProvenanceNote
          v-if="it.item.value.imported"
          :imported="it.item.value.imported"
        />

        <NbBanner
          v-if="it.saveError.value"
          status="error"
          variant="inline"
          :title="it.saveError.value"
        />

        <section class="item-modal__section">
          <h3>Description</h3>
          <MarkdownEditor
            v-if="editingDescription"
            v-model="it.draft.description"
            placeholder="Describe this item... headings, lists and code all work"
            class="item-modal__editor"
            autofocus
            @blur="commitDescription"
          />
          <div
            v-else-if="it.draft.description.trim()"
            class="item-modal__description"
            role="button"
            tabindex="0"
            aria-label="Description. Press Enter to edit."
            @click="editDescription"
            @keydown.enter.prevent="editDescription"
          >
            <MarkdownView :source="it.draft.description" />
          </div>
          <button
            v-else
            type="button"
            class="item-modal__description-empty"
            @click="editDescription"
          >
            Add a description...
          </button>
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
            <NbButton
              size="xxs"
              variant="ghost"
              icon="trash-simple"
              class="item-modal__section-action"
              :aria-label="`Delete checklist ${checklist.name}`"
              @click="confirmDeleteChecklist(checklist.name)"
            />
          </h3>
          <ChecklistBody
            :items="checklist.items"
            @toggle="(text, done) => it.toggleCheck(checklist.name, text, done)"
            @add="(text) => it.addChecklistEntry(checklist.name, text)"
            @remove="(text) => it.removeChecklistEntry(checklist.name, text)"
          />
        </section>

        <form class="item-modal__new-checklist" @submit.prevent="addChecklist">
          <NbTextInput
            id="field-modal-new-checklist"
            v-model="newChecklist"
            size="sm"
            placeholder="Add a checklist..."
            aria-label="New checklist name"
          />
          <NbButton
            type="submit"
            size="sm"
            variant="secondary"
            :disabled="!newChecklist.trim()"
          >
            Add checklist
          </NbButton>
        </form>

        <section class="item-modal__section">
          <h3>Attachments</h3>
          <AttachmentsPanel
            :owner="{ item: it.item.value.key }"
            :attachments="it.item.value.attachments ?? []"
            @changed="it.load"
          />
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
        <NbField v-slot="{ id }" label="Status">
          <NbSelect
            :id="id"
            v-model="it.draft.status"
            size="sm"
            :options="[...ITEM_STATUS_OPTIONS]"
            @change="it.commitStatus"
          />
        </NbField>
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
  </NbModal>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import {
  NbBadge,
  NbBanner,
  NbButton,
  NbDatePicker,
  NbDefinitionList,
  NbEmptyState,
  NbField,
  NbInlineEdit,
  NbInlineLoading,
  NbModal,
  NbSelect,
  NbSkeleton,
  NbTextInput,
  useConfirm,
} from '@nubisco/ui'
import { ITEM_STATUS_OPTIONS, useItem } from '@/composables/useItem'
import { labelVariants } from '@/lib/labels'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import AttachmentsPanel from '@/components/AttachmentsPanel.vue'
import ChecklistBody from '@/components/ChecklistBody.vue'
import CommentThread from '@/components/CommentThread.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import ProvenanceNote from '@/components/ProvenanceNote.vue'

const props = defineProps<{ open: boolean; itemKey: string }>()
const emit = defineEmits<{ close: [] }>()

const ws = useWorkspace()
const it = useItem(toRef(props, 'itemKey'))
const variants = computed(() => labelVariants(ws.overview.value))
const confirm = useConfirm()

const newChecklist = ref('')

function addChecklist(): void {
  void it.addChecklist(newChecklist.value)
  newChecklist.value = ''
}

function confirmDeleteChecklist(name: string): void {
  void confirm({
    title: 'Delete checklist',
    message: 'Every entry on it goes too.',
    subject: name,
    confirmLabel: 'Delete checklist',
    cancelLabel: 'Keep it',
    onConfirm: () => void it.deleteChecklist(name),
  })
}

// Presentation-first description: rendered markdown until the user opts into
// editing; the editor commits and yields the surface back on blur.
const editingDescription = ref(false)
watch(toRef(props, 'itemKey'), () => {
  editingDescription.value = false
})

function editDescription(): void {
  editingDescription.value = true
}

function commitDescription(): void {
  editingDescription.value = false
  it.commitDescription()
}
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
    align-items: start;
    gap: var(--nb-spacing-12);

    .nb-badge {
      margin-block-start: var(--nb-spacing-4);
      flex: none;
    }
  }

  &__title {
    flex: 1;
    min-inline-size: 0;
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
    border: 1px solid var(--nb-c-primary);
    border-radius: var(--nb-radius-sm, 8px);
    padding: var(--nb-spacing-12);

    :deep(.tiptap h1),
    :deep(.tiptap h2) {
      font-size: var(--nb-type-heading-02-size);
      line-height: 1.25;
    }

    :deep(.tiptap h3),
    :deep(.tiptap h4) {
      font-size: var(--nb-type-heading-01-size);
      line-height: 1.3;
    }
  }

  &__description {
    border-radius: var(--nb-radius-sm, 8px);
    padding: var(--nb-spacing-4);
    margin: calc(var(--nb-spacing-4) * -1);
    cursor: text;

    /* Item descriptions are notes, not documents: clamp the prose headings
     * to dialog scale. */
    :deep(.md h1),
    :deep(.md h2) {
      font-size: var(--nb-type-heading-02-size);
      line-height: 1.25;
    }

    :deep(.md h3),
    :deep(.md h4) {
      font-size: var(--nb-type-heading-01-size);
      line-height: 1.3;
    }

    &:hover {
      background: var(--nb-c-surface-hover);
    }

    &:focus-visible {
      outline: 2px solid var(--nb-c-focus-ring, var(--nb-c-primary));
      outline-offset: 1px;
    }
  }

  &__description-empty {
    border: 1px dashed var(--nb-c-border);
    border-radius: var(--nb-radius-sm, 8px);
    background: transparent;
    padding: var(--nb-spacing-12);
    color: var(--nb-c-text-subtle);
    font: inherit;
    text-align: start;
    cursor: text;

    &:hover {
      border-color: var(--nb-c-primary);
      color: var(--nb-c-text-muted);
    }
  }

  &__section-action {
    margin-inline-start: var(--nb-spacing-4);
    vertical-align: middle;
  }

  &__new-checklist {
    display: flex;
    gap: var(--nb-spacing-8);
    max-inline-size: 24rem;

    > :first-child {
      flex: 1;
    }
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
