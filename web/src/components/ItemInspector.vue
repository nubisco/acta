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
        <NbButton
          v-if="inspector.trail.value.length > 0"
          v-nb-tooltip="{ body: `Back to ${inspector.trail.value.at(-1)}` }"
          size="xs"
          variant="ghost"
          icon="arrow-left"
          :aria-label="`Back to ${inspector.trail.value.at(-1)}`"
          @click="inspector.back()"
        />
        <span class="inspector-key">{{ it.item.value.key }}</span>
        <NbBadge
          v-if="it.lifecycle.value"
          :variant="it.lifecycle.value.variant"
          :dot="it.lifecycle.value.dot"
          size="md"
        >
          {{ it.lifecycle.value.text }}
        </NbBadge>
        <span class="inspector-actions">
          <!-- Finding a card through search or a link drops you into this
               panel with no sense of where the card actually lives. The board
               marks the open card, so arriving there puts it under the
               reader's eye rather than making them hunt the column. -->
          <NbButton
            v-nb-tooltip="{ body: `Show on ${it.item.value.board}` }"
            size="xs"
            variant="ghost"
            icon="kanban"
            :aria-label="`Show ${it.item.value.key} on its board`"
            @click="viewOnBoard"
          />
          <!-- Archive was only ever reachable through the Status select,
               which is why it read as missing. Same set as the board's
               right-click menu, so both surfaces agree. -->
          <NbButton
            v-if="it.item.value.archived"
            v-nb-tooltip="{ body: 'Restore to its list' }"
            size="xs"
            variant="secondary"
            icon="arrow-counter-clockwise"
            :aria-label="`Restore ${it.item.value.key}`"
            @click="it.toggle('restore')"
          />
          <NbButton
            v-else
            v-nb-tooltip="{ body: 'Archive this card' }"
            size="xs"
            variant="ghost"
            icon="archive"
            :aria-label="`Archive ${it.item.value.key}`"
            @click="it.toggle('archive')"
          />
          <!-- Delete only on an archived card: archive is the reversible
               action, and the server refuses a delete before it. -->
          <NbButton
            v-if="it.item.value.archived"
            v-nb-tooltip="{ body: 'Delete permanently' }"
            size="xs"
            variant="danger"
            outlined
            icon="trash"
            :aria-label="`Delete ${it.item.value.key} permanently`"
            @click="confirmDelete"
          />
          <!-- Opening a card was a one-way door: the panel had a way back to
               the previous card but no way out, so the only exit was opening
               something else. Closing clears the trail too, otherwise the
               next card you open inherits a way "back" to one you already
               dismissed. -->
          <!-- Same card, more room. The panel is a column beside the board;
               some cards want the width, and switching should not mean losing
               your place and opening it again. -->
          <NbButton
            v-nb-tooltip="{ body: 'Open full size' }"
            size="xs"
            variant="ghost"
            icon="arrows-out-simple"
            :aria-label="`Open ${it.item.value.key} full size`"
            @click="expand"
          />
          <NbButton
            v-nb-tooltip="{ body: 'Close' }"
            size="xs"
            variant="ghost"
            icon="x"
            class="inspector-close"
            aria-label="Close the details panel"
            @click="inspector.close()"
          />
        </span>
      </div>
      <NbInlineEdit
        v-model="it.draft.title"
        label="Item title"
        size="lg"
        class="inspector-title"
        @commit="it.commitTitle"
      />
      <ProvenanceNote
        v-if="it.item.value.imported"
        :imported="it.item.value.imported"
        class="inspector-provenance"
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
          >
            <template #option="{ option }">
              <ActorChip :handle="String(option.value)" />
            </template>
            <template #value="{ values }">
              <span class="assignee-values">
                <ActorChip
                  v-for="handle in values"
                  :key="String(handle)"
                  :handle="String(handle)"
                />
              </span>
            </template>
          </NbSelect>
        </NbField>
        <NbField v-slot="{ id }" label="Labels">
          <NbSelect
            :id="id"
            v-model="it.draft.labels"
            size="sm"
            multiple
            :options="it.labelOptions.value"
            @change="it.commitLabels"
          >
            <template #option="{ option }">
              <LabelBadge :name="String(option.value)" />
            </template>
            <template #value="{ values }">
              <span class="label-values">
                <LabelBadge
                  v-for="name in values"
                  :key="String(name)"
                  :name="String(name)"
                />
              </span>
            </template>
          </NbSelect>
        </NbField>
        <form class="inspector-new-checklist" @submit.prevent="addChecklist">
          <NbTextInput
            id="field-inspector-new-checklist"
            v-model="newChecklist"
            size="sm"
            placeholder="Add a checklist..."
            aria-label="New checklist name"
          />
          <NbButton
            type="submit"
            size="xs"
            variant="secondary"
            :disabled="!newChecklist.trim()"
          >
            Add
          </NbButton>
        </form>
      </div>

      <!-- Everything past the core fields is a labelled, collapsible row.
           Stacked as panels, a long description pushed comments so far down
           the panel that a card with eleven of them read as having none; the
           counts in each header say what is there without opening it. -->
      <!-- Always visible. The description is what the card IS; putting it
           behind a disclosure means every card opens showing nothing. -->
      <div class="inspector-section">
        <h3 class="inspector-section__title">
          <NbIcon name="text-align-left" :size="15" />
          Description
        </h3>
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
          <MarkdownView :source="it.draft.description" :clamp="18" />
        </div>
        <button
          v-else
          type="button"
          class="inspector-description-empty"
          @click="editingDescription = true"
        >
          Add a description...
        </button>
      </div>

      <NbAccordion v-model="openSections" multiple flush size="sm">
        <NbAccordionItem
          v-for="checklist in it.item.value.checklists ?? []"
          :id="`checklist:${checklist.name}`"
          :key="checklist.name"
          :title="checklist.name"
        >
          <!-- In the meta slot because the header has no actions slot, and
               .stop so removing a checklist does not also toggle the section
               it lives in. -->
          <template #meta>
            <span class="inspector-progress">
              {{ checklist.items.filter((entry) => entry.done).length }}/{{
                checklist.items.length
              }}
            </span>
            <NbButton
              size="xxs"
              variant="ghost"
              icon="trash-simple"
              :aria-label="`Delete checklist ${checklist.name}`"
              @click.stop="confirmDeleteChecklist(checklist.name)"
            />
          </template>
          <ChecklistBody
            :items="checklist.items"
            @toggle="(text, done) => it.toggleCheck(checklist.name, text, done)"
            @add="(text) => it.addChecklistEntry(checklist.name, text)"
            @remove="(text) => it.removeChecklistEntry(checklist.name, text)"
          />
        </NbAccordionItem>

        <NbAccordionItem
          id="attachments"
          title="Attachments"
          :meta="countLabel(it.item.value.attachments)"
        >
          <AttachmentsPanel
            :owner="{ item: it.item.value.key }"
            :attachments="it.item.value.attachments ?? []"
            @changed="it.load"
          />
        </NbAccordionItem>

        <NbAccordionItem
          v-if="it.linkFacts.value.length > 0"
          id="links"
          title="Links"
          :meta="countLabel(it.linkFacts.value)"
        >
          <NbDefinitionList :items="it.linkFacts.value" layout="stacked" />
        </NbAccordionItem>
      </NbAccordion>
      <!-- Always visible, and last. Burying the conversation behind a
           disclosure is the fault this whole change exists to fix. -->
      <div class="inspector-section">
        <h3 class="inspector-section__title">
          <NbIcon name="chat-circle" :size="15" />
          Comments
          <span
            v-if="countLabel(it.item.value.comments)"
            class="inspector-section__count"
          >
            {{ countLabel(it.item.value.comments) }}
          </span>
        </h3>
        <CommentThread
          v-model="it.commentDraft.value"
          :comments="it.item.value.comments ?? []"
          :commenting="it.commenting.value"
          @submit="it.addComment"
        />
      </div>
    </NbShellPanel>
  </div>
</template>

<script setup lang="ts">
import { ref, toRef, watch } from 'vue'
import { useConfirm } from '@nubisco/ui'
import { ITEM_STATUS_OPTIONS, useItem } from '@/composables/useItem'
import { useRouter } from 'vue-router'
import { useInspector, useUiState } from '@/stores/workspace'
import { wpath } from '@/lib/paths'
import AttachmentsPanel from '@/components/AttachmentsPanel.vue'
import ActorChip from '@/components/ActorChip.vue'
import ChecklistBody from '@/components/ChecklistBody.vue'
import CommentThread from '@/components/CommentThread.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import ProvenanceNote from '@/components/ProvenanceNote.vue'
import LabelBadge from '@/components/LabelBadge.vue'

// Outside setup, so it survives the panel unmounting between cards.
const moduleOpenSections = ref<string[]>([
  'description',
  'comments',
  'attachments',
])

const props = defineProps<{ itemKey: string }>()

const it = useItem(toRef(props, 'itemKey'))
const inspector = useInspector()
const router = useRouter()
const ui = useUiState()

/**
 * Which sections are open, shared by every card opened this session.
 *
 * Module-level on purpose: someone who collapses the description to get at
 * the comments means it for the next card too, and re-expanding it on every
 * open would undo the change they just made. Reset only by a reload.
 */
const openSections = moduleOpenSections

/** A count for an accordion header, or nothing when there is none to give.
 *  Showing "0" would be noise on the many cards that have no attachments. */
function countLabel(list: unknown[] | undefined): string | undefined {
  return list && list.length > 0 ? String(list.length) : undefined
}

/** Hand this card to the full-size view. The panel closes, because the two
 *  showing the same card at once is a choice nobody asked to make. */
function expand(): void {
  const key = it.item.value?.key
  if (!key) return
  ui.itemModalKey.value = key
  inspector.close()
}

/** Go to the board this card lives on, leaving the panel open so the board's
 *  marker lands on the card the reader was already looking at. */
function viewOnBoard(): void {
  const board = it.item.value?.board
  if (board) void router.push(wpath(`/b/${board}`))
}
const confirm = useConfirm()

const newChecklist = ref('')

function addChecklist(): void {
  void it.addChecklist(newChecklist.value)
  newChecklist.value = ''
}

/**
 * Names what goes with the card. A confirm that only says "are you sure"
 * makes the reader guess whether comments and files survive.
 */
function confirmDelete(): void {
  const item = it.item.value
  if (!item) return
  const parts = [
    (item.comments?.length ?? 0) > 0 &&
      `${item.comments!.length} comment${item.comments!.length === 1 ? '' : 's'}`,
    (item.attachments?.length ?? 0) > 0 &&
      `${item.attachments!.length} attachment${item.attachments!.length === 1 ? '' : 's'}`,
    (item.checklists?.length ?? 0) > 0 && 'its checklists',
  ].filter(Boolean) as string[]
  void confirm({
    title: 'Delete this card',
    message: parts.length
      ? `${parts.join(', ')} go too. This cannot be undone.`
      : 'This cannot be undone.',
    subject: `${item.key} ${item.title}`,
    confirmLabel: 'Delete card',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      if (await it.remove()) inspector.close()
    },
  })
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

.inspector-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--nb-spacing-4);
  margin-inline-start: auto;
}

/* Set apart from archive and delete: close is the only one of the three that
   does nothing to the card, and sitting flush against a danger button invites
   the wrong click. */
.inspector-close {
  margin-inline-start: var(--nb-spacing-8);
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

  /* The title was rendering at the same 16px as the body prose and as a card
   * on the board, so nothing on the panel read as its heading. The class
   * lands on the inline-edit's own element, so the size belongs here rather
   * than on a child. */
  font-size: var(--nb-type-heading-02-size);
  line-height: 1.25;
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

.inspector-provenance {
  margin-block-end: var(--nb-spacing-8);
}

.inspector-new-checklist {
  display: flex;
  gap: var(--nb-spacing-8);

  > :first-child {
    flex: 1;
  }
}

.assignee-values {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-inline-size: 0;
}
</style>
