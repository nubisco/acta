<template>
  <div class="workspace">
    <NbPanel class="workspace__section">
      <header class="workspace__head">
        <div>
          <h2 class="type-heading-01">Deleting comments</h2>
          <p class="workspace__lede">
            A thread is a record of what was said, and workspaces disagree about
            how much of it should be removable. Letting people delete what they
            wrote keeps a thread readable, and someone who posted in the wrong
            place can tidy up after themselves. Keeping it to admins means
            nothing leaves a discussion without a moderator doing it, at the
            cost of a request every time. Editing is not affected either way:
            only the author of a comment can ever change it, and an edited
            comment says so. Admins can always delete, whichever of these is
            chosen, because moderating is what the role is for.
          </p>
        </div>
      </header>

      <NbRadio
        v-model="policy"
        name="comment-delete"
        label="Who can delete a comment"
        :options="POLICY_OPTIONS"
        :disabled="saving"
        @update:model-value="save"
      />
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
/**
 * Settings that belong to the workspace rather than to a person, and that
 * nobody but an admin can change.
 */
import { onMounted, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import { api, type TCommentDeletePolicy } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'
import { humanise } from '@/lib/state'

const POLICY_OPTIONS = [
  { label: 'The person who wrote it, or an admin', value: 'author' },
  { label: 'Only an admin', value: 'admin' },
]

const ws = useWorkspace()
const toast = useToast()

const policy = ref<TCommentDeletePolicy>('author')
const saving = ref(false)

// The overview already carries it, because every comment row's `can_delete`
// is decided by it. No second read.
onMounted(() => {
  policy.value = ws.overview.value?.policy?.comment_delete ?? 'author'
})

/**
 * Saved on change rather than behind a Save button, the same as every other
 * single-field section here: there is one choice and no way to get it into an
 * invalid state, so a button would exist only to be forgotten.
 *
 * The workspace is refreshed afterwards because the new policy changes what
 * `can_delete` says on comments the reader may already be looking at.
 */
async function save(next: string): Promise<void> {
  saving.value = true
  try {
    await api.setWorkspacePolicy({
      comment_delete: next as TCommentDeletePolicy,
    })
    await ws.refresh()
    toast.success('Saved')
  } catch (err) {
    policy.value = ws.overview.value?.policy?.comment_delete ?? 'author'
    toast.error(humanise(err), { title: 'Could not save' })
  } finally {
    saving.value = false
  }
}
</script>

<style scoped lang="scss">
.workspace {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);

  &__section {
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-16);
  }

  &__head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--nb-spacing-16);
  }

  &__lede {
    max-width: 68ch;
    margin-block-start: var(--nb-spacing-4);
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }
}
</style>
