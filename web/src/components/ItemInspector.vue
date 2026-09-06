<template>
  <div
    v-if="it.viewState.value === 'loading'"
    class="nb-inspector inspector-loading"
  >
    <NbSkeleton variant="heading" label="Loading item" />
    <NbSkeleton variant="text" :lines="3" />
    <NbSkeleton variant="block" height="8rem" />
  </div>

  <NbEmptyState
    v-else-if="it.viewState.value === 'error'"
    size="sm"
    kind="error"
    title="Could not load this item"
    :description="it.loadMessage.value"
  >
    <template #actions>
      <NbButton size="xs" variant="secondary" @click="it.load">Retry</NbButton>
    </template>
  </NbEmptyState>

  <div v-else-if="it.item.value" class="nb-inspector">
    <NbShellPanel title="Details" fluid>
      <template #toolbar>
        <NbInlineLoading
          :status="it.save.status.value"
          label="Saving"
          finished-label="Saved"
          error-label="Not saved"
          :dwell="1200"
          reserve-space
        />
      </template>
      <div class="inspector-head">
        <span class="inspector-key">{{ it.item.value.key }}</span>
        <NbBadge
          v-if="it.lifecycle.value"
          :variant="it.lifecycle.value.variant"
          :dot="it.lifecycle.value.dot"
          size="md"
        >
          {{ it.lifecycle.value.text }}
        </NbBadge>
      </div>
      <NbInlineEdit
        v-model="it.draft.title"
        label="Item title"
        size="lg"
        class="inspector-title"
        @commit="it.commitTitle"
      />
      <NbBanner
        v-if="it.saveError.value"
        status="error"
        variant="inline"
        :title="it.saveError.value"
      />
      <div class="inspector-fields">
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
      </div>
    </NbShellPanel>

    <NbShellPanel title="Description" fluid>
      <MarkdownEditor
        v-if="editingDescription"
        v-model="it.draft.description"
        placeholder="Describe this item..."
        class="inspector-editor"
        autofocus
        @blur="commitDescription"
      />
      <div
        v-else-if="it.draft.description.trim()"
        class="inspector-description"
        role="button"
        tabindex="0"
        aria-label="Description. Press Enter to edit."
        @click="editingDescription = true"
        @keydown.enter.prevent="editingDescription = true"
      >
        <MarkdownView :source="it.draft.description" />
      </div>
      <button
        v-else
        type="button"
        class="inspector-description-empty"
        @click="editingDescription = true"
      >
        Add a description...
      </button>
    </NbShellPanel>

    <NbShellPanel
      v-for="checklist in it.item.value.checklists ?? []"
      :key="checklist.name"
      :title="checklist.name"
      fluid
    >
      <template #toolbar>
        <span class="inspector-progress">
          {{ checklist.items.filter((entry) => entry.done).length }}/{{
            checklist.items.length
          }}
        </span>
      </template>
      <ul class="inspector-checklist">
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
    </NbShellPanel>

    <NbShellPanel title="Comments" fill>
      <CommentThread
        v-model="it.commentDraft.value"
        :comments="it.item.value.comments ?? []"
        :commenting="it.commenting.value"
        @submit="it.addComment"
      />
    </NbShellPanel>

    <NbShellPanel v-if="it.linkFacts.value.length > 0" title="Links" fluid>
      <NbDefinitionList :items="it.linkFacts.value" layout="stacked" />
    </NbShellPanel>
  </div>
</template>

<script setup lang="ts">
import { ref, toRef, watch } from 'vue'
import {
  NbBadge,
  NbBanner,
  NbButton,
  NbCheckbox,
  NbDatePicker,
  NbDefinitionList,
  NbEmptyState,
  NbField,
  NbInlineEdit,
  NbInlineLoading,
  NbSelect,
  NbShellPanel,
  NbSkeleton,
} from '@nubisco/ui'
import { ITEM_STATUS_OPTIONS, useItem } from '@/composables/useItem'
import CommentThread from '@/components/CommentThread.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'

const props = defineProps<{ itemKey: string }>()

const it = useItem(toRef(props, 'itemKey'))

// Presentation-first description, same contract as the item modal.
const editingDescription = ref(false)
watch(toRef(props, 'itemKey'), () => {
  editingDescription.value = false
})

function commitDescription(): void {
  editingDescription.value = false
  it.commitDescription()
}
</script>

<style scoped lang="scss">
.inspector-loading {
  display: grid;
  gap: var(--nb-spacing-12);
  padding: var(--nb-spacing-16);
}

.inspector-head {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-8);
  margin-block-end: var(--nb-spacing-12);
}

.inspector-key {
  font-family: var(--nb-font-family-mono);
  font-size: var(--nb-type-code-sm-size);
  color: var(--nb-c-text-subtle);
}

.inspector-fields {
  display: grid;
  gap: var(--nb-spacing-8);
}

.inspector-title {
  margin-block-end: var(--nb-spacing-12);
}

.inspector-editor {
  border: 1px solid var(--nb-c-primary);
  border-radius: var(--nb-radius-sm, 8px);
  padding: var(--nb-spacing-8);

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

.inspector-description {
  border-radius: var(--nb-radius-sm, 8px);
  padding: var(--nb-spacing-4);
  margin: calc(var(--nb-spacing-4) * -1);
  cursor: text;

  /* Item descriptions are notes, not documents: clamp the prose headings
   * to panel scale. */
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

.inspector-description-empty {
  border: 1px dashed var(--nb-c-border);
  border-radius: var(--nb-radius-sm, 8px);
  background: transparent;
  padding: var(--nb-spacing-8);
  color: var(--nb-c-text-subtle);
  font: inherit;
  font-size: var(--nb-type-body-sm-size);
  text-align: start;
  cursor: text;
  width: 100%;

  &:hover {
    border-color: var(--nb-c-primary);
    color: var(--nb-c-text-muted);
  }
}

.inspector-progress {
  font-size: var(--nb-type-label-sm-size);
  color: var(--nb-c-text-muted);
}

.inspector-checklist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--nb-spacing-8);
}
</style>
