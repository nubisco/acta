<template>
  <div class="account">
    <NbBanner
      v-if="freshToken"
      status="info"
      variant="inline"
      title="Copy this token now; it is shown once"
      dismissible
      @close="freshToken = ''"
    >
      <NbField v-slot="{ id }" label="Token" orientation="stack">
        <div class="account__reveal">
          <NbTextInput :id="id" :model-value="freshToken" readonly size="sm" />
          <NbButton size="sm" variant="secondary" @click="copy(freshToken)">
            Copy token
          </NbButton>
        </div>
      </NbField>
    </NbBanner>

    <NbPanel class="account__section">
      <header class="account__head">
        <div>
          <h2 class="type-heading-01">Access tokens</h2>
          <p class="account__lede">
            A token lets an editor, a script or an MCP client act as
            <strong>you</strong>, with your role. Work done through one is
            attributed to you, not to a bot. Tokens never carry admin rights, so
            administration still takes a signed-in session.
          </p>
        </div>
        <NbButton
          size="sm"
          variant="primary"
          icon="plus"
          @click="creating = true"
        >
          New token
        </NbButton>
      </header>

      <NbDataTable
        :columns="tokenColumns"
        :rows="tokenRows"
        row-key="id"
        size="sm"
        aria-label="Access tokens"
        :loading="tokensLoading"
      >
        <template #cell-actions="{ row }">
          <NbButton
            size="sm"
            variant="ghost"
            :aria-label="`Revoke ${row.label}`"
            @click="revokeToken(String(row.id), String(row.label))"
          >
            Revoke
          </NbButton>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="No access tokens"
            description="Create one to use Acta from an editor, a script or an MCP client."
          />
        </template>
      </NbDataTable>
    </NbPanel>

    <!--
      Connected applications. An OAuth grant was previously a one-way door:
      the column that ends one existed and was honoured, but nothing set it
      and nothing listed a grant, so authorising Claude could not be undone
      from the interface at all.
    -->
    <NbPanel class="account__section">
      <header class="account__head">
        <div>
          <h2 class="type-heading-01">Connected applications</h2>
          <p class="account__lede">
            Applications you have signed in to Acta from, such as the Claude or
            ChatGPT connectors. They act as you, and they can be cut off here at
            any time.
          </p>
        </div>
      </header>

      <NbDataTable
        :columns="appColumns"
        :rows="appRows"
        row-key="client_id"
        size="sm"
        aria-label="Connected applications"
        :loading="appsLoading"
      >
        <template #cell-actions="{ row }">
          <NbButton
            size="sm"
            variant="ghost"
            :aria-label="`Revoke access for ${row.name}`"
            @click="revokeApp(String(row.client_id), String(row.name))"
          >
            Revoke
          </NbButton>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="Nothing connected"
            description="Connect Acta from Claude or another MCP client and it appears here."
          />
        </template>
      </NbDataTable>
    </NbPanel>

    <NewTokenModal
      :open="creating"
      kind="personal"
      @close="creating = false"
      @created="onCreated"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * Everything on this screen belongs to whoever is signed in, which is why
 * nothing here is gated on admin: an admin has no business seeing, or
 * cutting, what somebody else connected to their own account.
 */
import { computed, onMounted, ref } from 'vue'
import { useConfirm, useToast } from '@nubisco/ui'
import { auth } from '@/api/client'
import { humanise } from '@/lib/state'
import NewTokenModal from '@/components/NewTokenModal.vue'

const toast = useToast()
const confirm = useConfirm()

const creating = ref(false)
const freshToken = ref('')

const tokensLoading = ref(false)
const tokens = ref<Awaited<ReturnType<typeof auth.tokens>>['tokens']>([])

const appsLoading = ref(false)
const apps = ref<Awaited<ReturnType<typeof auth.apps>>['apps']>([])

const tokenColumns = [
  { key: 'label', header: 'Label' },
  { key: 'access', header: 'Access' },
  { key: 'created', header: 'Created' },
  { key: 'used', header: 'Last used' },
  { key: 'actions', header: '' },
]

const appColumns = [
  { key: 'name', header: 'Application' },
  { key: 'access', header: 'Access' },
  { key: 'connected', header: 'Connected' },
  { key: 'used', header: 'Last used' },
  { key: 'actions', header: '' },
]

/**
 * "Never" rather than an empty cell. It is the fact that makes an old
 * credential safe to revoke: nobody remembers what they pasted a token into a
 * year ago, but never having been used is decisive.
 */
function usedLabel(at: number | null | undefined): string {
  return at ? new Date(at).toLocaleDateString() : 'Never'
}

const tokenRows = computed(() =>
  tokens.value.map((t) => ({
    id: t.id,
    label: t.label,
    access: t.scopes.includes('write') ? 'Read and write' : 'Read only',
    created: new Date(t.created_at).toLocaleDateString(),
    used: usedLabel(t.last_used_at),
  })),
)

const appRows = computed(() =>
  apps.value.map((a) => ({
    client_id: a.client_id,
    name: a.name,
    access: a.scopes.includes('write') ? 'Read and write' : 'Read only',
    connected: new Date(a.created_at).toLocaleDateString(),
    used: usedLabel(a.last_used_at),
  })),
)

async function loadTokens(): Promise<void> {
  tokensLoading.value = true
  try {
    tokens.value = (await auth.tokens()).tokens
  } catch (err) {
    toast.error(humanise(err))
  } finally {
    tokensLoading.value = false
  }
}

async function loadApps(): Promise<void> {
  appsLoading.value = true
  try {
    apps.value = (await auth.apps()).apps
  } catch (err) {
    toast.error(humanise(err))
  } finally {
    appsLoading.value = false
  }
}

onMounted(() => {
  void loadTokens()
  void loadApps()
})

function onCreated(token: string): void {
  creating.value = false
  freshToken.value = token
  void loadTokens()
}

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  toast.success('Copied')
}

function revokeToken(id: string, label: string): void {
  void confirm({
    title: 'Revoke token',
    message:
      'Anything still using this token stops working immediately. This cannot be undone.',
    subject: label,
    confirmLabel: 'Revoke token',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      try {
        await auth.revokeToken(id)
        await loadTokens()
        toast.success('Token revoked')
      } catch (err) {
        toast.error(humanise(err), { title: 'Revoke failed' })
      }
    },
  })
}

function revokeApp(clientId: string, name: string): void {
  void confirm({
    title: 'Revoke access',
    message: `${name} loses access to your workspace immediately and will have to be authorised again. This cannot be undone.`,
    subject: name,
    confirmLabel: 'Revoke access',
    cancelLabel: 'Keep it connected',
    onConfirm: async () => {
      try {
        await auth.revokeApp(clientId)
        await loadApps()
        toast.success(`${name} disconnected`)
      } catch (err) {
        toast.error(humanise(err), { title: 'Revoke failed' })
      }
    },
  })
}
</script>

<style scoped lang="scss">
.account {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);

  &__section {
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-16);
  }

  /* The action sits with the heading it belongs to, not below the table it
     acts on. A primary button stranded under a list reads as a footer for
     the page rather than the control for that section. */
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

  &__reveal {
    display: flex;
    gap: var(--nb-spacing-8);
    align-items: end;
  }
}
</style>
