<template>
  <NbModal
    :open="open"
    size="lg"
    :title="it.item.value?.key ?? 'Item'"
    @close="emit('close')"
  >
    <!-- The same trail as the side panel: the card this one was reached
         from, and the way back to it. -->
    <template v-if="it.item.value" #header>
      <CardTrail :card-key="it.item.value.key" />
    </template>
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
        <!-- Above the title, as in the side panel. The two surfaces show the
             same card, so they say the same things in the same order. -->
        <PartOfChip
          v-if="it.item.value.parent"
          :item-key="it.item.value.key"
          :space="it.item.value.space"
          :parent="it.item.value.parent"
          @changed="it.load"
          @open="onOpenRelated"
        />
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
          <span class="item-modal__actions">
            <NbInlineLoading
              :status="it.save.status.value"
              label="Saving"
              finished-label="Saved"
              error-label="Not saved"
              :dwell="1200"
              reserve-space
            />
            <!-- Back to the side panel, on the same card. The pair reads as
                 one control that toggles size rather than two ways to open a
                 card that happen to look alike. -->
            <NbButton
              v-nb-tooltip="{ body: 'Show in the side panel' }"
              size="sm"
              variant="ghost"
              icon="arrows-in-simple"
              :aria-label="`Show ${it.item.value.key} in the side panel`"
              @click="collapse"
            />
            <!-- Archive was only ever reachable through the Status select,
                 which is why it read as missing. Same set as the space's
                 right-click menu, so both surfaces agree. -->
            <NbButton
              v-if="it.item.value.archived"
              v-nb-tooltip="{ body: 'Restore to its list' }"
              size="sm"
              variant="secondary"
              icon="arrow-counter-clockwise"
              :aria-label="`Restore ${it.item.value.key}`"
              @click="it.toggle('restore')"
            />
            <NbButton
              v-else
              v-nb-tooltip="{ body: 'Archive this card' }"
              size="sm"
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
              size="sm"
              variant="danger"
              outlined
              icon="trash"
              :aria-label="`Delete ${it.item.value.key} permanently`"
              @click="confirmDelete"
            />
          </span>
        </div>

        <!-- The card's own data, at the top of the card, the way every tool
             that shows a card in a window puts it. In a right-hand column it
             competed with the conversation for the eye and left the widest
             part of the modal holding a comment box. -->
        <div class="item-modal__props">
          <!-- The list is the status (Jose, 2026-10-09): one field, not a
               Status and a List that could disagree. Done means a done list. -->
          <NbField v-slot="{ id }" label="Status" orientation="stack">
            <NbSelect
              :id="id"
              v-model="it.draft.list"
              size="sm"
              :options="it.listOptions.value"
              @change="it.commitList"
            />
          </NbField>
          <NbField v-slot="{ id }" label="Due" orientation="stack">
            <NbDatePicker
              :id="id"
              v-model="it.draft.due"
              size="sm"
              @change="it.commitDue"
            />
          </NbField>
          <NbField v-slot="{ id }" label="Priority" orientation="stack">
            <NbSelect
              :id="id"
              v-model="it.draft.priority"
              size="sm"
              :options="PRIORITY_OPTIONS"
              @change="it.commitPriority"
            />
          </NbField>
          <NbField v-slot="{ id }" label="Assignees" orientation="stack">
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
          <NbField v-slot="{ id }" label="Labels" orientation="stack">
            <NbSelect
              :id="id"
              v-model="it.draft.labels"
              size="sm"
              multiple
              :options="it.labelOptions.value"
              @change="it.commitLabels"
            >
              <template #option="{ option }">
                <span
                  v-if="headingName(String(option.value))"
                  class="label-group-heading"
                >
                  {{ headingName(String(option.value)) }}
                </span>
                <LabelBadge v-else :id="String(option.value)" size="md" />
              </template>
              <template #value="{ values }">
                <span class="label-values">
                  <LabelBadge
                    v-for="labelId in values"
                    :id="String(labelId)"
                    :key="String(labelId)"
                    qualify
                    size="md"
                  />
                </span>
              </template>
            </NbSelect>
          </NbField>
          <NbDefinitionList
            v-if="it.linkFacts.value.length > 0"
            layout="stacked"
          >
            <NbDefinitionListItem
              v-for="(fact, i) in it.linkFacts.value"
              :key="i"
              :term="fact.term"
            >
              <RefText v-if="fact.opens === 'item'" :text="fact.value" />
              <RouterLink
                v-else-if="fact.opens === 'doc'"
                :to="wpath(`/docs/${fact.value}`)"
              >
                {{ fact.value }}
              </RouterLink>
              <template v-else>{{ fact.value }}</template>
            </NbDefinitionListItem>
          </NbDefinitionList>
        </div>

        <!-- First of the relations: what the card is for. -->
        <section class="item-modal__section">
          <h3>
            Goals
            <NbInfoHint
              :text="SECTION_INFO.goals"
              :size="14"
              label="About goals"
            />
          </h3>
          <ItemGoalsPanel
            :item-key="it.item.value.key"
            :goals="it.item.value.goals ?? []"
            @changed="it.load"
          />
        </section>

        <!-- Its own section, beside Plan. Composition and sequence are
             different relations and stay visibly apart. -->
        <section class="item-modal__section">
          <h3>
            Parts
            <NbInfoHint
              :text="SECTION_INFO.parts"
              :size="14"
              label="About parts"
            />
          </h3>
          <PartsPanel
            :item-key="it.item.value.key"
            :space="it.item.value.space"
            :parts="it.item.value.parts ?? []"
            @changed="it.load"
            @open="onOpenRelated"
          />
        </section>

        <section class="item-modal__section">
          <h3>
            Plan
            <NbInfoHint
              :text="SECTION_INFO.plan"
              :size="14"
              label="About the plan"
            />
          </h3>
          <DependencyPanel
            :item-key="it.item.value.key"
            :space="it.item.value.space"
            :blocked-by="it.item.value.blocked_by ?? []"
            :blocks="it.item.value.blocks ?? []"
            :size="it.item.value.size"
            :is-milestone="it.item.value.is_milestone"
            @changed="it.load"
            @open="onOpenRelated"
          />
        </section>

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
          <h3>
            Description
            <NbInfoHint
              :text="SECTION_INFO.description"
              :size="14"
              label="About the description"
            />
          </h3>
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
            <MarkdownView :source="it.draft.description" :clamp="28" />
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
            <NbIcon name="list-checks" :size="16" />
            {{ checklist.name }}
            <NbInfoHint
              :text="SECTION_INFO.checklist"
              :size="14"
              label="About checklists"
            />
            <SectionCount
              :text="`${ticked(checklist)}/${checklist.items.length}`"
              :tip="`${ticked(checklist)} of ${checklist.items.length} ticked`"
              :empty="checklist.items.length === 0"
            />
            <NbButton
              v-nb-tooltip="{ body: `Delete the ${checklist.name} checklist` }"
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
          <h3>
            Attachments
            <NbInfoHint
              :text="SECTION_INFO.attachments"
              :size="14"
              label="About attachments"
            />
          </h3>
          <AttachmentsPanel
            :owner="{ item: it.item.value.key }"
            :attachments="it.item.value.attachments ?? []"
            @changed="it.load"
          />
        </section>

        <section class="item-modal__section">
          <h3>
            History
            <NbInfoHint
              :text="SECTION_INFO.history"
              :size="14"
              label="About history"
            />
          </h3>
          <ItemHistory
            :item-key="it.item.value.key"
            :events="it.item.value.activity ?? []"
            :created="it.item.value.created"
            :updated="it.item.value.updated"
            :created-by="it.item.value.created_by"
            @open="onOpenRelated"
          />
        </section>
      </div>

      <!-- The conversation gets the column. It is the part of a card that
           grows without limit, so it is the part that needs its own scroll
           rather than a strip under everything else. -->
      <aside class="item-modal__conversation" aria-label="Comments">
        <section class="item-modal__section">
          <h3>
            Comments
            <NbInfoHint
              :text="SECTION_INFO.comments"
              :size="14"
              label="About comments"
            />
          </h3>
          <CommentThread
            v-model="it.commentDraft.value"
            :comments="it.item.value.comments ?? []"
            :commenting="it.commenting.value"
            @submit="it.addComment"
            @edit="it.editComment"
            @delete="it.deleteComment"
          />
        </section>
      </aside>
    </div>
  </NbModal>
</template>

<script setup lang="ts">
import { ref, toRef, watch } from 'vue'
import RefText from '@/components/RefText.vue'
import SectionCount from '@/components/SectionCount.vue'
import { SECTION_INFO } from '@/lib/sections'
import { wpath } from '@/lib/paths'
import { useConfirm } from '@nubisco/ui'
import { useItem } from '@/composables/useItem'
import { useInspector } from '@/stores/workspace'
import ActorChip from '@/components/ActorChip.vue'
import AttachmentsPanel from '@/components/AttachmentsPanel.vue'
import ChecklistBody from '@/components/ChecklistBody.vue'
import CommentThread from '@/components/CommentThread.vue'
import ItemHistory from '@/components/ItemHistory.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import ProvenanceNote from '@/components/ProvenanceNote.vue'
import LabelBadge from '@/components/LabelBadge.vue'
import { headingName } from '@/lib/labels'
import DependencyPanel from '@/components/DependencyPanel.vue'
import PartsPanel from '@/components/PartsPanel.vue'
import ItemGoalsPanel from '@/components/goals/ItemGoalsPanel.vue'
import PartOfChip from '@/components/PartOfChip.vue'
import CardTrail from '@/components/CardTrail.vue'
import { PRIORITY_OPTIONS } from '@/lib/priority'

const props = defineProps<{ open: boolean; itemKey: string }>()
const emit = defineEmits<{ close: [] }>()

const it = useItem(toRef(props, 'itemKey'))
const confirm = useConfirm()
const inspector = useInspector()

/** Follow a dependency without leaving the full-size view. It goes on the
 *  card trail like any other hop, so the way back is in the header. */
function onOpenRelated(key: string): void {
  inspector.open(key)
}

/** Hand this card back to the side panel. Closing the modal and opening the
 *  panel on the same key, so the pair behaves as one control that changes the
 *  card's size rather than two separate ways to open it. */
function collapse(): void {
  inspector.setFull(false)
}

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
      if (await it.remove()) emit('close')
    },
  })
}

function ticked(checklist: { items: { done: boolean }[] }): number {
  return checklist.items.filter((entry) => entry.done).length
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
  /* The conversation gets a real column now, not a 16rem strip: it is the
     part of a card that grows without limit. The card's own fields moved to
     the top of the main column, where they are read once rather than
     competing with the thread for attention. */
  grid-template-columns: minmax(0, 1fr) minmax(20rem, 24rem);
  gap: var(--nb-spacing-24);
  align-items: start;

  @media (max-width: 60rem) {
    grid-template-columns: minmax(0, 1fr);
  }

  /* Fields flow across the top instead of stacking down a sidebar. Each keeps
     a floor so a label like "Assignees" never wraps to its own line, and they
     wrap as a group when the modal is narrow. */
  &__props {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: var(--nb-spacing-8) var(--nb-spacing-16);
    align-items: start;
    padding-block-end: var(--nb-spacing-12);
    border-block-end: 1px solid var(--nb-c-border);
  }

  &__conversation {
    display: grid;
    gap: var(--nb-spacing-8);
    min-inline-size: 0;
    /* Its own scroll, so a long thread does not push the card's own data off
       the top of the window. */
    max-block-size: min(70vh, 44rem);
    overflow-y: auto;
  }

  &__loading {
    display: grid;
    gap: var(--nb-spacing-12);
  }

  &__main {
    display: grid;
    gap: var(--nb-spacing-16);
    min-inline-size: 0;
  }

  &__actions {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    margin-inline-start: auto;
    margin-block-start: var(--nb-spacing-2);
    flex: none;
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

    /* Same reason as the inspector: at 16px the title matched the body prose
     * beneath it and read as another paragraph. */
    font-size: var(--nb-type-heading-02-size);
    line-height: 1.25;
  }

  /* The side panel's section heading, exactly: one card, one heading style,
     whichever size it is shown at (UX audit, 2026-10-09). */
  &__section h3 {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    margin: 0 0 var(--nb-spacing-8);
    font-family: var(--nb-type-label-lg-family);
    font-size: var(--nb-type-label-lg-size);
    font-weight: var(--nb-type-label-lg-weight);
    line-height: var(--nb-type-label-lg-line-height);
    color: var(--nb-c-text);

    :deep(.nb-badge) {
      text-transform: none;
      letter-spacing: 0;
    }
  }

  &__editor {
    border: 1px solid var(--nb-c-primary);
    border-radius: var(--nb-radius-sm);
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
    border-radius: var(--nb-radius-sm);
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
      outline: 2px solid var(--nb-c-focus-ring);
      outline-offset: 1px;
    }
  }

  &__description-empty {
    border: 1px dashed var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
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

  @media (max-width: 42rem) {
    grid-template-columns: 1fr;
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
