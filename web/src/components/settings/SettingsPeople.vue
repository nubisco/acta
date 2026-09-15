<template>
  <NbPanel class="people-settings">
    <header class="people-settings__head">
      <div>
        <h2 class="type-heading-01">People</h2>
        <p class="people-settings__lede">
          Everyone who can sign in to this workspace. Only people can be
          assigned work or mentioned. Automations that create items on your
          behalf live under Automation.
        </p>
      </div>
      <NbButton
        v-if="ws.isAdmin.value"
        size="sm"
        variant="primary"
        icon="plus"
        @click="inviting = true"
      >
        Add member
      </NbButton>
    </header>

    <NbDataTable
      :columns="columns"
      :rows="rows"
      row-key="id"
      size="sm"
      aria-label="People"
    >
      <template #cell-person="{ row }">
        <span class="people-settings__person">
          <button
            v-if="row.canEditAvatar"
            v-nb-tooltip="{ body: 'Change picture' }"
            type="button"
            class="people-settings__avatar-button"
            :aria-label="`Change picture for ${row.name}`"
            @click="openAvatar(row)"
          >
            <ActorAvatar :handle="String(row.rawHandle)" />
          </button>
          <ActorAvatar v-else :handle="String(row.rawHandle)" />
          <span class="people-settings__names">
            <span class="people-settings__name">{{ row.name }}</span>
            <span class="people-settings__handle">{{ row.handle }}</span>
          </span>
        </span>
      </template>
      <template #cell-role="{ row }">
        <NbBadge size="sm" :variant="row.role === 'admin' ? 'purple' : 'blue'">
          {{ row.role === 'admin' ? 'Admin' : 'Member' }}
        </NbBadge>
      </template>
      <template #empty>
        <NbEmptyState
          size="sm"
          title="Nobody here yet"
          description="Add the first member and they can sign in with their email."
        />
      </template>
    </NbDataTable>

    <NewMemberModal
      :open="inviting"
      @close="inviting = false"
      @created="onCreated"
    />
    <AvatarUploadModal
      v-if="avatarTarget"
      :open="avatarTarget !== null"
      :actor-id="avatarTarget.id"
      :has-avatar="avatarTarget.hasAvatar"
      @close="avatarTarget = null"
      @saved="avatarTarget = null"
    />
  </NbPanel>
</template>

<script setup lang="ts">
/**
 * People, and only people.
 *
 * This table used to list every actor in the workspace, which put the GitHub
 * connection and two contact-form tokens in a list headed "Members" next to
 * the humans. It made a fair question unanswerable: what does it mean to
 * assign a ticket to a contact form? Those identities still exist and still
 * author events, they just are not members and do not belong here.
 */
import { computed, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import NewMemberModal from '@/components/NewMemberModal.vue'
import AvatarUploadModal from '@/components/AvatarUploadModal.vue'

const ws = useWorkspace()
const toast = useToast()

const inviting = ref(false)
const avatarTarget = ref<{ id: string; hasAvatar: boolean } | null>(null)

const columns = [
  { key: 'person', header: 'Person' },
  { key: 'role', header: 'Role' },
]

const rows = computed(() =>
  (ws.overview.value?.actors ?? [])
    .filter((a) => a.kind === 'human')
    .map((a) => ({
      id: a.id,
      handle: `@${a.handle}`,
      rawHandle: a.handle,
      name: a.name,
      role: a.role,
      hasAvatar: Boolean(a.avatar_url),
      // Your own picture is yours to change, anyone else's needs admin.
      canEditAvatar: a.id === ws.me.value?.id || ws.isAdmin.value,
    })),
)

function openAvatar(row: unknown): void {
  const actor = row as { id: string; hasAvatar: boolean }
  avatarTarget.value = { id: actor.id, hasAvatar: actor.hasAvatar }
}

function onCreated(): void {
  inviting.value = false
  toast.success('Member added. They can sign in with their email now.')
}
</script>

<style scoped lang="scss">
.people-settings {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-16);

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

  &__person {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    min-inline-size: 0;
  }

  /* Name over handle: the handle is storage, the name is what people read.
     Both are needed here because the handle is what gets typed in a mention. */
  &__names {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  }

  &__name,
  &__handle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__handle {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

  &__avatar-button {
    padding: 0;
    background: none;
    border: 0;
    border-radius: 50%;
    cursor: pointer;
    line-height: 0;

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 2px;
    }
  }
}
</style>
