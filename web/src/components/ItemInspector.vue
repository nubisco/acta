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
      <NbBanner
        v-if="it.saveError.value"
        status="error"
        variant="inline"
        :title="it.saveError.value"
      />
      <div class="inspector-fields">
        <NbField v-slot="{ id }" label="Title">
          <NbTextInput
            :id="id"
            v-model="it.draft.title"
            size="sm"
            @blur="it.commitTitle"
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
        v-model="it.draft.description"
        placeholder="Describe this item..."
        class="inspector-editor"
        @blur="it.commitDescription"
      />
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

    <footer class="inspector-actions">
      <NbButton
        size="xs"
        :variant="it.item.value.done ? 'secondary' : 'primary'"
        @click="it.toggle(it.item.value.done ? 'reopen' : 'complete')"
      >
        {{ it.item.value.done ? 'Reopen' : 'Complete' }}
      </NbButton>
      <NbButton
        size="xs"
        variant="ghost"
        outlined
        @click="it.toggle(it.item.value.archived ? 'restore' : 'archive')"
      >
        {{ it.item.value.archived ? 'Restore' : 'Archive' }}
      </NbButton>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
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
  NbSelect,
  NbShellPanel,
  NbSkeleton,
  NbTextInput,
} from '@nubisco/ui'
import { useItem } from '@/composables/useItem'
import CommentThread from '@/components/CommentThread.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'

const props = defineProps<{ itemKey: string }>()

const it = useItem(toRef(props, 'itemKey'))
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

.inspector-editor {
  border: 1px solid var(--nb-c-border);
  border-radius: var(--nb-radius-sm, 8px);
  padding: var(--nb-spacing-8);

  &:focus-within {
    border-color: var(--nb-c-primary);
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

.inspector-actions {
  display: flex;
  gap: var(--nb-spacing-8);
  padding: var(--nb-spacing-16);
  border-block-start: 1px solid var(--nb-c-border);
}
</style>
