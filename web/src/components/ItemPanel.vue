<template>
  <div v-if="item" class="item">
    <header class="item__header">
      <NbBadge>{{ item.key }}</NbBadge>
      <span class="item__list">{{ item.list }}</span>
      <NbButton
        variant="ghost"
        size="sm"
        icon="x"
        aria-label="Close"
        @click="emit('close')"
      />
    </header>

    <h2 v-if="!editingTitle" class="item__title" @dblclick="startTitleEdit">
      {{ item.title }}
      <s v-if="item.done" class="item__done-mark" />
    </h2>
    <NbTextInput
      v-else
      v-model="titleDraft"
      autofocus
      @keyup.enter="saveTitle"
      @blur="saveTitle"
    />

    <div class="item__chips">
      <NbLabel v-for="label in item.labels ?? []" :key="label" :text="label" />
      <NbBadge
        v-for="assignee in item.assignees ?? []"
        :key="assignee"
        variant="grey"
      >
        @{{ assignee }}
      </NbBadge>
      <NbBadge
        v-if="item.due"
        :variant="item.due < Date.now() && !item.done ? 'red' : 'grey'"
      >
        due {{ new Date(item.due).toLocaleDateString() }}
      </NbBadge>
    </div>

    <section class="item__section">
      <header>
        <h3>Description</h3>
        <NbButton
          v-if="!editingDesc"
          variant="ghost"
          size="sm"
          @click="startDescEdit"
          >Edit</NbButton
        >
      </header>
      <MarkdownView
        v-if="!editingDesc"
        :source="item.description || '*No description*'"
      />
      <template v-else>
        <textarea v-model="descDraft" class="item__editor" rows="10" />
        <div class="item__actions">
          <NbButton variant="ghost" size="sm" @click="editingDesc = false"
            >Cancel</NbButton
          >
          <NbButton variant="primary" size="sm" @click="saveDesc"
            >Save</NbButton
          >
        </div>
      </template>
    </section>

    <section
      v-for="checklist in item.checklists ?? []"
      :key="checklist.name"
      class="item__section"
    >
      <header>
        <h3>{{ checklist.name }}</h3>
        <span class="item__chk-progress">
          {{ checklist.items.filter((i) => i.done).length }}/{{
            checklist.items.length
          }}
        </span>
      </header>
      <ul class="item__checklist">
        <li v-for="entry in checklist.items" :key="entry.text">
          <NbCheckbox
            :model-value="entry.done"
            :label="entry.text"
            @update:model-value="
              (done: boolean) => toggleCheck(checklist.name, entry.text, done)
            "
          />
        </li>
      </ul>
    </section>

    <section class="item__section">
      <header>
        <h3>Comments</h3>
      </header>
      <ul class="item__comments">
        <li v-for="comment in item.comments ?? []" :key="comment.id">
          <div class="item__comment-head">
            <strong>@{{ comment.by }}</strong>
            <NbAiLabel v-if="comment.agent" />
            <time>{{ new Date(comment.ts).toLocaleString() }}</time>
          </div>
          <MarkdownView :source="comment.body" />
        </li>
      </ul>
      <div class="item__comment-box">
        <textarea
          v-model="commentDraft"
          rows="2"
          placeholder="Write a comment... ([[@handle]] to mention)"
        />
        <NbButton
          variant="primary"
          size="sm"
          :disabled="!commentDraft.trim()"
          @click="addComment"
        >
          Comment
        </NbButton>
      </div>
    </section>

    <section
      v-if="
        item.links && (item.links.in.length > 0 || item.links.out.length > 0)
      "
      class="item__section"
    >
      <header><h3>Links</h3></header>
      <ul class="item__links">
        <li
          v-for="link in item.links.out"
          :key="`out-${link.ref_type}-${link.target}`"
        >
          → {{ link.ref_type }}: {{ link.target }}
        </li>
        <li
          v-for="link in item.links.in"
          :key="`in-${link.src_kind}-${link.src_id}`"
        >
          ← referenced by {{ link.src_kind }} {{ link.src_id }}
        </li>
      </ul>
    </section>

    <footer class="item__footer">
      <NbButton
        size="sm"
        :variant="item.done ? 'ghost' : 'primary'"
        @click="toggle(item.done ? 'reopen' : 'complete')"
      >
        {{ item.done ? 'Reopen' : 'Complete' }}
      </NbButton>
      <NbButton
        size="sm"
        variant="ghost"
        @click="toggle(item.archived ? 'restore' : 'archive')"
      >
        {{ item.archived ? 'Restore' : 'Archive' }}
      </NbButton>
    </footer>
  </div>
  <div v-else class="item item--loading"><NbSpinner /></div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  NbAiLabel,
  NbBadge,
  NbButton,
  NbCheckbox,
  NbLabel,
  NbSpinner,
  NbTextInput,
  useToast,
} from '@nubisco/ui'
import { api, newOpId, type IItemDetail } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'
import MarkdownView from '@/components/MarkdownView.vue'

const props = defineProps<{ itemKey: string }>()
const emit = defineEmits<{ close: [] }>()

const ws = useWorkspace()
const toast = useToast()
const item = ref<IItemDetail | null>(null)
const editingTitle = ref(false)
const editingDesc = ref(false)
const titleDraft = ref('')
const descDraft = ref('')
const commentDraft = ref('')

async function load(): Promise<void> {
  const { items } = await api.itemGet([props.itemKey])
  item.value = items[0]
}

watch(() => props.itemKey, load, { immediate: true })
ws.onLive((event) => {
  if (event.entity === 'item' && item.value && event.actor_kind !== 'human')
    void load()
})

function startTitleEdit(): void {
  titleDraft.value = item.value?.title ?? ''
  editingTitle.value = true
}

async function saveTitle(): Promise<void> {
  if (!item.value || !editingTitle.value) return
  editingTitle.value = false
  if (titleDraft.value.trim() === item.value.title) return
  await write({
    op: 'update',
    op_id: newOpId(),
    key: item.value.key,
    if_rev: item.value.rev,
    title: titleDraft.value.trim(),
  })
}

function startDescEdit(): void {
  descDraft.value = item.value?.description ?? ''
  editingDesc.value = true
}

async function saveDesc(): Promise<void> {
  if (!item.value) return
  editingDesc.value = false
  await write({
    op: 'update',
    op_id: newOpId(),
    key: item.value.key,
    if_rev: item.value.rev,
    description: descDraft.value,
  })
}

async function addComment(): Promise<void> {
  if (!item.value) return
  const body = commentDraft.value.trim()
  commentDraft.value = ''
  await write({ op: 'comment', op_id: newOpId(), key: item.value.key, body })
}

async function toggleCheck(
  checklist: string,
  text: string,
  done: boolean,
): Promise<void> {
  if (!item.value) return
  await write({
    op: 'checklist_set',
    op_id: newOpId(),
    key: item.value.key,
    checklist,
    ...(done ? { check: [text] } : { uncheck: [text] }),
  })
}

async function toggle(
  op: 'complete' | 'reopen' | 'archive' | 'restore',
): Promise<void> {
  if (!item.value) return
  await write({ op, op_id: newOpId(), key: item.value.key })
}

async function write(
  op: Parameters<typeof api.itemWrite>[0][number],
): Promise<void> {
  const { results } = await api.itemWrite([op])
  const result = results[0]
  if (!result.ok) {
    const err = result as { error: string; current?: { rev?: number } }
    if (err.current?.rev)
      toast.error('Someone else changed this item; reloaded', {
        title: 'Conflict',
      })
    else toast.error(err.error)
  }
  await load()
}
</script>

<style scoped lang="scss">
.item {
  padding: calc(var(--nb-base-unit) * 2);
  display: grid;
  gap: calc(var(--nb-base-unit) * 2);
  align-content: start;

  &--loading {
    place-items: center;
    min-height: 200px;
  }

  &__header {
    display: flex;
    align-items: center;
    gap: var(--nb-base-unit);

    :last-child {
      margin-left: auto;
    }
  }

  &__list {
    font-size: 0.85rem;
    opacity: 0.7;
  }

  &__title {
    margin: 0;
    cursor: text;
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--nb-base-unit) / 2);
  }

  &__section {
    display: grid;
    gap: var(--nb-base-unit);

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;

      h3 {
        margin: 0;
        font-size: 0.9rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
      }
    }
  }

  &__editor,
  &__comment-box textarea {
    width: 100%;
    font-family: var(--nb-font-mono, monospace);
    font-size: 0.9rem;
    padding: var(--nb-base-unit);
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    background: transparent;
    color: inherit;
    resize: vertical;
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--nb-base-unit);
  }

  &__checklist,
  &__comments,
  &__links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: calc(var(--nb-base-unit) / 2);
  }

  &__comment-head {
    display: flex;
    align-items: center;
    gap: var(--nb-base-unit);
    font-size: 0.8rem;

    time {
      opacity: 0.5;
    }
  }

  &__comment-box {
    display: grid;
    gap: calc(var(--nb-base-unit) / 2);
    justify-items: end;
  }

  &__chk-progress {
    font-size: 0.8rem;
    opacity: 0.6;
  }

  &__links {
    font-size: 0.85rem;
    opacity: 0.8;
  }

  &__footer {
    display: flex;
    gap: var(--nb-base-unit);
    border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
    padding-top: calc(var(--nb-base-unit) * 2);
  }
}
</style>
