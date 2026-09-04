<template>
  <div class="settings">
    <h1>Settings</h1>

    <component :is="filterBar.Outlet">
      <NbTabs
        v-model="tab"
        :items="tabs"
        aria-label="Settings sections"
        variant="line"
      />
    </component>

    <section v-if="tab === 'members'" class="settings__section">
      <NbBanner
        v-if="freshToken"
        status="info"
        variant="inline"
        title="Copy this token now; it is shown once"
        dismissible
        @close="freshToken = ''"
      >
        <div class="settings__token">
          <NbTextInput
            id="field-fresh-token"
            :model-value="freshToken"
            readonly
            size="sm"
            aria-label="New token"
          />
          <NbButton size="sm" variant="secondary" @click="copyToken">
            Copy
          </NbButton>
        </div>
      </NbBanner>

      <NbDataTable
        :columns="actorColumns"
        :rows="actorRows"
        row-key="handle"
        size="sm"
        aria-label="Members and agents"
      >
        <template #cell-kind="{ row }">
          <NbAiLabel v-if="row.kind === 'agent'" />
          <NbBadge v-else-if="row.kind === 'system'" size="sm" variant="grey">
            System
          </NbBadge>
          <span v-else>Human</span>
        </template>
      </NbDataTable>

      <div v-if="ws.isAdmin.value" class="settings__row">
        <NbButton size="sm" variant="primary" @click="invitingMember = true">
          Add member
        </NbButton>
        <NbButton size="sm" variant="secondary" @click="creatingAgent = true">
          New agent token
        </NbButton>
      </div>
    </section>

    <section v-if="tab === 'labels'" class="settings__section">
      <div
        v-for="group in labelGroups"
        :key="`${group.name}:${group.board ?? ''}`"
        class="settings__labels"
      >
        <h2>
          {{ group.name }}
          <span v-if="group.board" class="settings__scope">
            {{ group.board }}
          </span>
        </h2>
        <div class="settings__chips">
          <NbBadge v-for="label in group.labels" :key="label.id" size="sm">
            {{ label.name }}
          </NbBadge>
        </div>
      </div>
    </section>

    <section v-if="tab === 'webhooks'" class="settings__section">
      <NbDataTable
        :columns="webhookColumns"
        :rows="webhookRows"
        row-key="id"
        size="sm"
        aria-label="Webhooks"
        :loading="listsLoading"
        :error="listsError"
      >
        <template #cell-status="{ row }">
          <NbBadge size="sm" :variant="row.statusVariant" :dot="row.statusDot">
            {{ row.status }}
          </NbBadge>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="No webhooks yet"
            description="Webhooks POST signed events to your systems as work changes."
          >
            <template #actions>
              <NbButton
                v-if="ws.isAdmin.value"
                size="xs"
                variant="primary"
                @click="creatingWebhook = true"
              >
                Create webhook
              </NbButton>
            </template>
          </NbEmptyState>
        </template>
      </NbDataTable>
      <div v-if="ws.isAdmin.value" class="settings__row">
        <NbButton size="sm" variant="primary" @click="creatingWebhook = true">
          New webhook
        </NbButton>
      </div>
    </section>

    <section v-if="tab === 'rules'" class="settings__section">
      <NbBanner
        status="info"
        variant="callout"
        title="Rules are managed through the API"
      >
        Create and edit automation rules with the rule_write tool over MCP or
        the REST API; this table is the audit surface.
      </NbBanner>
      <NbDataTable
        :columns="ruleColumns"
        :rows="ruleRows"
        row-key="id"
        size="sm"
        aria-label="Automation rules"
        :loading="listsLoading"
        :error="listsError"
      >
        <template #cell-status="{ row }">
          <NbBadge
            size="sm"
            :variant="row.enabled ? 'green' : 'grey'"
            :dot="row.enabled"
          >
            {{ row.enabled ? 'Active' : 'Inactive' }}
          </NbBadge>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="No rules yet"
            description="Rules react to events: move an ingested item, apply a label, post a comment."
          />
        </template>
      </NbDataTable>
    </section>

    <section v-if="tab === 'ingest'" class="settings__section">
      <NbBanner
        v-if="freshIngestToken"
        status="info"
        variant="inline"
        title="Copy this endpoint now; the token is shown once"
        dismissible
        @close="freshIngestToken = ''"
      >
        <div class="settings__token">
          <NbTextInput
            id="field-fresh-ingest"
            :model-value="ingestEndpoint"
            readonly
            size="sm"
            aria-label="Ingest endpoint"
          />
          <NbButton size="sm" variant="secondary" @click="copyIngest">
            Copy
          </NbButton>
        </div>
      </NbBanner>
      <p>
        Ingest tokens let external forms create items directly:
        <code>POST /api/v1/ingest/&lt;token&gt;</code> with a JSON title,
        description, and labels.
      </p>
      <div v-if="ws.isAdmin.value" class="settings__row">
        <NbButton size="sm" variant="primary" @click="creatingIngest = true">
          New ingest token
        </NbButton>
      </div>
    </section>

    <NewMemberModal
      :open="invitingMember"
      @close="invitingMember = false"
      @created="onMemberCreated"
    />
    <NewTokenModal
      :open="creatingAgent"
      kind="agent"
      @close="creatingAgent = false"
      @created="onAgentToken"
    />
    <NewTokenModal
      :open="creatingIngest"
      kind="ingest"
      @close="creatingIngest = false"
      @created="onIngestToken"
    />
    <NewWebhookModal
      :open="creatingWebhook"
      @close="creatingWebhook = false"
      @created="onWebhookCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NbAiLabel,
  NbBadge,
  NbBanner,
  NbButton,
  NbDataTable,
  NbEmptyState,
  NbTabs,
  NbTextInput,
  useShellSlot,
  useToast,
} from '@nubisco/ui'
import { api } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import NewMemberModal from '@/components/NewMemberModal.vue'
import NewTokenModal from '@/components/NewTokenModal.vue'
import NewWebhookModal from '@/components/NewWebhookModal.vue'

const ws = useWorkspace()
const toast = useToast()
const filterBar = useShellSlot('fixedbar')

const tab = ref('members')
const tabs = [
  { id: 'members', label: 'Members' },
  { id: 'labels', label: 'Labels' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'rules', label: 'Rules' },
  { id: 'ingest', label: 'Ingest' },
]

const invitingMember = ref(false)
const creatingAgent = ref(false)
const creatingIngest = ref(false)
const creatingWebhook = ref(false)
const freshToken = ref('')
const freshIngestToken = ref('')

const ingestEndpoint = computed(
  () => `${window.location.origin}/api/v1/ingest/${freshIngestToken.value}`,
)

const actorColumns = [
  { key: 'handle', header: 'Handle' },
  { key: 'name', header: 'Name' },
  { key: 'kind', header: 'Kind' },
]
const actorRows = computed(() =>
  (ws.overview.value?.actors ?? []).map((a) => ({
    handle: `@${a.handle}`,
    name: a.name,
    kind: a.kind,
  })),
)

const labelGroups = computed(() => {
  const groups = new Map<
    string,
    {
      name: string
      board: string | null
      labels: { id: string; name: string }[]
    }
  >()
  for (const label of ws.overview.value?.labels ?? []) {
    const key = `${label.group_name}:${label.board_key ?? ''}`
    if (!groups.has(key))
      groups.set(key, {
        name: label.group_name,
        board: label.board_key,
        labels: [],
      })
    groups.get(key)!.labels.push({ id: label.id, name: label.name })
  }
  return [...groups.values()]
})

const listsLoading = ref(true)
const listsError = ref('')

interface IWebhookRowView {
  id: string
  url: string
  events: string
  failures: number
  status: string
  statusVariant: 'green' | 'grey' | 'orange'
  statusDot: boolean
}

const webhookRows = ref<IWebhookRowView[]>([])
const webhookColumns = [
  { key: 'url', header: 'URL' },
  { key: 'events', header: 'Events' },
  { key: 'status', header: 'Status' },
  { key: 'failures', header: 'Failures' },
]

interface IRuleRowView {
  id: string
  name: string
  trigger: string
  condition: string
  enabled: boolean
}

const ruleRows = ref<IRuleRowView[]>([])
const ruleColumns = [
  { key: 'name', header: 'Name' },
  { key: 'trigger', header: 'Trigger' },
  { key: 'condition', header: 'Condition' },
  { key: 'status', header: 'Status' },
]

async function refreshLists(): Promise<void> {
  listsLoading.value = true
  listsError.value = ''
  try {
    const [webhooks, rules] = await Promise.all([api.webhooks(), api.rules()])
    webhookRows.value = webhooks.webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events.join(', '),
      failures: w.failures,
      status: !w.enabled ? 'Inactive' : w.failures > 0 ? 'Attention' : 'Active',
      statusVariant: !w.enabled ? 'grey' : w.failures > 0 ? 'orange' : 'green',
      statusDot: w.enabled,
    }))
    ruleRows.value = rules.rules.map((r) => ({
      id: r.id,
      name: r.name,
      trigger: r.trigger,
      condition: r.condition ?? '',
      enabled: r.enabled,
    }))
  } catch (err) {
    listsError.value = humanise(err)
  } finally {
    listsLoading.value = false
  }
}

void refreshLists()

function onMemberCreated(): void {
  invitingMember.value = false
  toast.success('Member added; they can sign in with their email now.')
}

function onAgentToken(token: string): void {
  creatingAgent.value = false
  freshToken.value = token
}

function onIngestToken(token: string): void {
  creatingIngest.value = false
  freshIngestToken.value = token
}

function onWebhookCreated(): void {
  creatingWebhook.value = false
  void refreshLists()
}

async function copyToken(): Promise<void> {
  await navigator.clipboard.writeText(freshToken.value)
  toast.success('Token copied')
}

async function copyIngest(): Promise<void> {
  await navigator.clipboard.writeText(ingestEndpoint.value)
  toast.success('Endpoint copied')
}
</script>

<style scoped lang="scss">
.settings {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  h1 {
    margin: 0;
  }

  &__section {
    display: grid;
    gap: var(--nb-spacing-16);
    justify-items: start;
  }

  &__row {
    display: flex;
    gap: var(--nb-spacing-8);
  }

  &__token {
    display: flex;
    gap: var(--nb-spacing-8);
    align-items: center;
    margin-block-start: var(--nb-spacing-8);
  }

  &__labels h2 {
    margin: 0 0 var(--nb-spacing-8);
    font-size: var(--nb-type-heading-01-size);
  }

  &__scope {
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-subtle);
    margin-inline-start: var(--nb-spacing-4);
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--nb-spacing-4);
  }

  p {
    max-width: 68ch;
    margin: 0;
  }

  code {
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
  }
}
</style>
