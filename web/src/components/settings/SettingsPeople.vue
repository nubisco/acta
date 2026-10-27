<template>
  <div class="people-settings">
    <NbDataTable
      stack-on-phone
      :columns="columns"
      :rows="rows"
      row-key="id"
      size="sm"
      title="People"
      description="Everyone who can sign in to this workspace. Only people can be assigned work or mentioned. Automations that create items on your behalf live under Automation."
    >
      <template #toolbar-actions>
        <NbButton
          v-if="ws.isAdmin.value"
          variant="primary"
          icon="plus"
          @click="inviting = true"
        >
          Invite member
        </NbButton>
      </template>
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
          description="Invite the first member. They join when they accept."
        />
      </template>
    </NbDataTable>

    <NbDataTable
      v-if="ws.isAdmin.value && invitations.length > 0"
      stack-on-phone
      :columns="inviteColumns"
      :rows="inviteRows"
      row-key="id"
      size="sm"
      title="Pending invitations"
      :description="invitesDescription"
    >
      <template #cell-person="{ row }">
        <span class="people-settings__names">
          <span class="people-settings__name">{{ row.name }}</span>
          <span class="people-settings__handle">{{ row.email }}</span>
        </span>
      </template>
      <template #cell-role="{ row }">
        <NbBadge size="sm" :variant="row.role === 'admin' ? 'purple' : 'blue'">
          {{ row.role === 'admin' ? 'Admin' : 'Member' }}
        </NbBadge>
      </template>
      <template #cell-status="{ row }">
        <NbBadge size="sm" :variant="row.expired ? 'grey' : 'green'">
          {{ row.status }}
        </NbBadge>
      </template>
      <template #cell-actions="{ row }">
        <NbButton
          size="sm"
          variant="ghost"
          :loading="revoking === row.id"
          @click="revoke(String(row.id))"
        >
          Revoke
        </NbButton>
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
  </div>
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
import { computed, onMounted, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import { api, type IInvitation } from '@/api/client'
import { humanise } from '@/lib/state'
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

/**
 * Invitations not yet accepted. Admin only, on the server as well: a member
 * asking gets a 403, which is why this is not loaded for them at all.
 */
const invitations = ref<IInvitation[]>([])
const emailsLeft = ref<number | null>(null)

// The table's description, with today's remaining invitation emails when the
// server reports them.
const invitesDescription = computed(() => {
  const base =
    'Not members yet. They join when they accept, and nothing else is sent to them until then.'
  if (emailsLeft.value === null) return base
  const noun = emailsLeft.value === 1 ? 'email' : 'emails'
  return `${base} ${emailsLeft.value} invitation ${noun} left today.`
})
const revoking = ref<string | null>(null)

const inviteColumns = [
  { key: 'person', header: 'Invited' },
  { key: 'role', header: 'Role' },
  { key: 'status', header: 'Status' },
  { key: 'actions', header: '' },
]

const inviteRows = computed(() =>
  invitations.value.map((i) => ({
    id: i.id,
    name: i.name,
    email: i.email,
    role: i.role,
    expired: i.status === 'expired',
    status:
      i.status === 'expired'
        ? 'Expired'
        : i.emailed
          ? 'Invitation sent'
          : 'Waiting for the link',
  })),
)

async function loadInvitations(): Promise<void> {
  if (!ws.isAdmin.value) return
  try {
    const out = await api.invitations()
    invitations.value = out.invitations
    emailsLeft.value = out.emails_left_today
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not load invitations' })
  }
}
onMounted(loadInvitations)

async function revoke(id: string): Promise<void> {
  revoking.value = id
  try {
    await api.revokeInvitation(id)
    await loadInvitations()
    toast.success('Invitation revoked. The link no longer works.')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not revoke the invitation' })
  } finally {
    revoking.value = null
  }
}

function onCreated(emailed: boolean): void {
  void loadInvitations()
  if (emailed) toast.success('Invitation sent. They join when they accept.')
}
</script>

<style scoped lang="scss">
.people-settings {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);

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
