<template>
  <div class="automation">
    <!--
      One page, four mechanisms, each introduced by what it is FOR rather
      than by what it is called. These used to be four sibling tabs (Ingest,
      Connections, Webhooks, Rules) plus a button on the Members tab, with
      nothing anywhere saying how an "agent token" differs from an "ingest
      token" or an "access token". The direction of the arrow is the thing
      that actually distinguishes them, so each section leads with it.
    -->

    <NbBanner
      v-if="fresh"
      status="info"
      variant="inline"
      :title="fresh.title"
      dismissible
      @close="fresh = null"
    >
      <NbField
        v-for="field in fresh.fields"
        :key="field.label"
        v-slot="{ id }"
        :label="field.label"
        orientation="stack"
      >
        <div class="automation__reveal">
          <NbTextInput :id="id" :model-value="field.value" readonly size="sm" />
          <NbButton size="sm" variant="secondary" @click="copy(field.value)">
            Copy
          </NbButton>
        </div>
      </NbField>
      <p v-if="fresh.hint" class="automation__hint">{{ fresh.hint }}</p>
    </NbBanner>

    <!-- Inbound, unauthenticated senders ------------------------------- -->
    <NbPanel class="automation__section">
      <header class="automation__head">
        <div>
          <h2 class="type-heading-01">Ingest endpoints</h2>
          <p class="automation__lede">
            A URL you paste into a website form or another tool. Anything posted
            to it becomes a card on the space you choose. The URL is the
            credential, so treat it as a secret.
          </p>
        </div>
        <NbButton
          v-if="ws.isAdmin.value"
          size="sm"
          variant="primary"
          icon="plus"
          @click="creatingIngest = true"
        >
          New endpoint
        </NbButton>
      </header>

      <NbDataTable
        :columns="ingestColumns"
        :rows="ingestRows"
        row-key="id"
        size="sm"
        aria-label="Ingest endpoints"
        :loading="loading"
        :error="error"
      >
        <template #cell-used="{ row }">
          <span :class="{ automation__never: row.used === 'Never' }">
            {{ row.used }}
          </span>
        </template>
        <template #cell-actions="{ row }">
          <NbButton
            v-if="ws.isAdmin.value"
            size="sm"
            variant="ghost"
            :aria-label="`Revoke ${row.name}`"
            @click="revokeIngest(String(row.id), String(row.name))"
          >
            Revoke
          </NbButton>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="No ingest endpoints"
            description="Create one to turn a contact form or an external tool into cards."
          />
        </template>
      </NbDataTable>
    </NbPanel>

    <!-- Inbound, signed providers -------------------------------------- -->
    <NbPanel class="automation__section">
      <header class="automation__head">
        <div>
          <h2 class="type-heading-01">Connections</h2>
          <p class="automation__lede">
            A provider pushes signed events to Acta. GitHub issues become
            tracking cards on the space you pick, and every delivery is verified
            against a shared secret.
          </p>
        </div>
        <NbButton
          v-if="ws.isAdmin.value"
          size="sm"
          variant="primary"
          icon="plus"
          @click="creatingConnection = true"
        >
          Connect GitHub
        </NbButton>
      </header>

      <NbDataTable
        :columns="connectionColumns"
        :rows="connectionRows"
        row-key="id"
        size="sm"
        aria-label="Connections"
        :loading="loading"
        :error="error"
      >
        <template #cell-status="{ row }">
          <NbBadge size="sm" :variant="row.statusVariant" :dot="row.statusDot">
            {{ row.status }}
          </NbBadge>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="No connections yet"
            description="Connect a GitHub repository and its issues become tracking cards."
          />
        </template>
      </NbDataTable>
    </NbPanel>

    <!-- Outbound ------------------------------------------------------- -->
    <NbPanel class="automation__section">
      <header class="automation__head">
        <div>
          <h2 class="type-heading-01">Webhooks</h2>
          <p class="automation__lede">
            The other direction. Acta posts signed events to your systems as
            work changes, or to a Slack channel.
          </p>
        </div>
        <NbButton
          v-if="ws.isAdmin.value"
          size="sm"
          variant="primary"
          icon="plus"
          @click="creatingWebhook = true"
        >
          New webhook
        </NbButton>
      </header>

      <NbDataTable
        :columns="webhookColumns"
        :rows="webhookRows"
        row-key="id"
        size="sm"
        aria-label="Webhooks"
        :loading="loading"
        :error="error"
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
          />
        </template>
      </NbDataTable>
    </NbPanel>

    <!-- Internal ------------------------------------------------------- -->
    <NbPanel class="automation__section">
      <header class="automation__head">
        <div>
          <h2 class="type-heading-01">Rules</h2>
          <p class="automation__lede">
            Acta reacting to itself. When something happens to an item, and the
            item matches, do one thing to it.
          </p>
        </div>
        <NbButton
          v-if="ws.isAdmin.value"
          size="sm"
          variant="primary"
          icon="plus"
          @click="editingRule = { rule: null }"
        >
          New rule
        </NbButton>
      </header>

      <NbDataTable
        :columns="ruleColumns"
        :rows="ruleRows"
        row-key="id"
        size="sm"
        aria-label="Rules"
        :loading="loading"
        :error="error"
      >
        <template #cell-status="{ row }">
          <NbBadge
            size="sm"
            :variant="row.enabled ? 'green' : 'grey'"
            :dot="Boolean(row.enabled)"
          >
            {{ row.enabled ? 'Active' : 'Inactive' }}
          </NbBadge>
        </template>
        <template #cell-actions="{ row }">
          <div class="automation__actions">
            <NbButton
              v-if="ws.isAdmin.value"
              size="sm"
              variant="ghost"
              icon="pencil-simple"
              :aria-label="`Edit rule ${row.name}`"
              @click="openRule(String(row.id))"
            />
            <NbButton
              v-if="ws.isAdmin.value"
              size="sm"
              variant="danger"
              outlined
              icon="trash-simple"
              :aria-label="`Delete rule ${row.name}`"
              @click="deleteRule(String(row.id), String(row.name))"
            />
          </div>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="No rules yet"
            description="A rule reacts to a change: move an item, apply a label, post a comment."
          />
        </template>
      </NbDataTable>
    </NbPanel>

    <!-- Identities ----------------------------------------------------- -->
    <NbPanel class="automation__section">
      <header class="automation__head">
        <div>
          <h2 class="type-heading-01">Agent tokens</h2>
          <p class="automation__lede">
            A credential for a script or a bot that acts as
            <strong>itself</strong>, with its own name in the activity feed. To
            let a tool act as <strong>you</strong> instead, use an access token
            under Your account.
          </p>
        </div>
        <NbButton
          v-if="ws.isAdmin.value"
          size="sm"
          variant="primary"
          icon="plus"
          @click="creatingAgent = true"
        >
          New agent token
        </NbButton>
      </header>

      <NbDataTable
        :columns="agentColumns"
        :rows="agentRows"
        row-key="id"
        size="sm"
        aria-label="Agent identities"
      >
        <template #cell-agent="{ row }">
          <span class="automation__agent">
            <ActorAvatar :handle="String(row.handle)" :size="22" />
            <span>{{ row.name }}</span>
          </span>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="No agents"
            description="Agent tokens let a script post as its own identity rather than as a person."
          />
        </template>
      </NbDataTable>
    </NbPanel>

    <NewTokenModal
      :open="creatingIngest"
      kind="ingest"
      @close="creatingIngest = false"
      @created="onIngestCreated"
    />
    <NewTokenModal
      :open="creatingAgent"
      kind="agent"
      @close="creatingAgent = false"
      @created="onAgentCreated"
    />
    <NewWebhookModal
      :open="creatingWebhook"
      @close="creatingWebhook = false"
      @created="onWebhookCreated"
    />
    <NewConnectionModal
      :open="creatingConnection"
      @close="creatingConnection = false"
      @created="onConnectionCreated"
    />
    <RuleEditModal
      :open="editingRule !== null"
      :rule="editingRule?.rule ?? null"
      @close="editingRule = null"
      @saved="onRuleSaved"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useConfirm, useToast } from '@nubisco/ui'
import { api, newOpId as opId } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import NewTokenModal from '@/components/NewTokenModal.vue'
import NewWebhookModal from '@/components/NewWebhookModal.vue'
import NewConnectionModal from '@/components/NewConnectionModal.vue'
import RuleEditModal from '@/components/settings/RuleEditModal.vue'
import {
  describeAction,
  describeTrigger,
  type IRuleView,
} from '@/components/settings/rules'

const ws = useWorkspace()
const toast = useToast()
const confirm = useConfirm()

const loading = ref(true)
const error = ref('')

const creatingIngest = ref(false)
const creatingAgent = ref(false)
const creatingWebhook = ref(false)
const creatingConnection = ref(false)
const editingRule = ref<{ rule: IRuleView | null } | null>(null)

/**
 * A secret that exists once. Every mechanism here hands one back at creation
 * and never again, so they share one reveal rather than four.
 */
const fresh = ref<{
  title: string
  fields: { label: string; value: string }[]
  hint?: string
} | null>(null)

const ingestTokens = ref<
  Awaited<ReturnType<typeof api.ingestTokens>>['tokens']
>([])
const rules = ref<IRuleView[]>([])
const webhooks = ref<Awaited<ReturnType<typeof api.webhooks>>['webhooks']>([])
const connections = ref<
  Awaited<ReturnType<typeof api.connections>>['connections']
>([])

const ingestColumns = [
  { key: 'name', header: 'Name' },
  { key: 'target', header: 'Creates cards in' },
  { key: 'items', header: 'Items' },
  { key: 'used', header: 'Last used' },
  { key: 'actions', header: '' },
]
const connectionColumns = [
  { key: 'name', header: 'Name' },
  { key: 'provider', header: 'Provider' },
  { key: 'target', header: 'Creates cards in' },
  { key: 'status', header: 'Status' },
]
const webhookColumns = [
  { key: 'url', header: 'URL' },
  { key: 'destination', header: 'Destination' },
  { key: 'events', header: 'Events' },
  { key: 'status', header: 'Status' },
  { key: 'failures', header: 'Failures' },
]
const ruleColumns = [
  { key: 'name', header: 'Name' },
  { key: 'when', header: 'When' },
  { key: 'match', header: 'Matching' },
  { key: 'does', header: 'Then' },
  { key: 'status', header: 'Status' },
  { key: 'actions', header: '' },
]
const agentColumns = [
  { key: 'agent', header: 'Agent' },
  { key: 'handle', header: 'Handle' },
]

const ingestRows = computed(() =>
  ingestTokens.value.map((t) => ({
    id: t.id,
    name: t.name,
    target: t.list ? `${t.space} · ${t.list}` : t.space,
    items: t.items,
    // Never used is what makes an old endpoint safe to revoke.
    used: t.last_used_at
      ? new Date(t.last_used_at).toLocaleDateString()
      : 'Never',
  })),
)

type TStatusVariant = 'green' | 'grey' | 'orange'

const connectionRows = computed(() =>
  connections.value.map((c) => ({
    id: c.id,
    name: c.name,
    provider: c.provider,
    target: c.list ? `${c.space} · ${c.list}` : c.space,
    status: !c.enabled
      ? 'Inactive'
      : c.last_error
        ? 'Attention'
        : c.last_event_at
          ? 'Active'
          : 'Waiting',
    statusVariant: (!c.enabled
      ? 'grey'
      : c.last_error
        ? 'orange'
        : 'green') as TStatusVariant,
    statusDot: c.enabled,
  })),
)

const webhookRows = computed(() =>
  webhooks.value.map((w) => ({
    id: w.id,
    url: w.url,
    destination: w.format === 'slack' ? 'Slack' : 'Signed JSON',
    events: w.events.join(', '),
    failures: w.failures,
    status: !w.enabled ? 'Inactive' : w.failures > 0 ? 'Attention' : 'Active',
    statusVariant: (!w.enabled
      ? 'grey'
      : w.failures > 0
        ? 'orange'
        : 'green') as TStatusVariant,
    statusDot: w.enabled,
  })),
)

const ruleRows = computed(() =>
  rules.value.map((r) => ({
    id: r.id,
    name: r.name,
    when: describeTrigger(r.trigger),
    match: r.condition ?? 'Everything',
    does: describeAction(r.action),
    enabled: r.enabled,
  })),
)

const agentRows = computed(() =>
  (ws.overview.value?.actors ?? [])
    .filter((a) => a.kind === 'agent')
    .map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
)

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [hooks, ruleList, cons, ingests] = await Promise.all([
      api.webhooks(),
      api.rules(),
      api.connections(),
      // Admin only. A member sees the rest of this page read-only and must
      // not have the request fail the whole load on their behalf.
      ws.isAdmin.value
        ? api.ingestTokens()
        : Promise.resolve({ tokens: [] as typeof ingestTokens.value }),
    ])
    webhooks.value = hooks.webhooks
    rules.value = ruleList.rules as IRuleView[]
    connections.value = cons.connections
    ingestTokens.value = ingests.tokens
  } catch (err) {
    error.value = humanise(err)
  } finally {
    loading.value = false
  }
}

void refresh()

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  toast.success('Copied')
}

function onIngestCreated(token: string): void {
  creatingIngest.value = false
  fresh.value = {
    title: 'Copy this URL now. It is shown once.',
    fields: [
      {
        label: 'Endpoint',
        value: `${window.location.origin}/api/v1/ingest/${token}`,
      },
    ],
    hint: 'POST JSON with a title, description and labels. Anyone holding this URL can create cards, so treat it as a password.',
  }
  void refresh()
}

function onAgentCreated(token: string): void {
  creatingAgent.value = false
  fresh.value = {
    title: 'Copy this token now. It is shown once.',
    fields: [{ label: 'Token', value: token }],
  }
}

function onWebhookCreated(): void {
  creatingWebhook.value = false
  void refresh()
}

function onConnectionCreated(payload: { id: string; secret: string }): void {
  creatingConnection.value = false
  fresh.value = {
    title: 'Add these to the repository now. The secret is shown once.',
    fields: [
      {
        label: 'Payload URL',
        value: `${window.location.origin}/api/v1/hooks/github/${payload.id}`,
      },
      { label: 'Secret', value: payload.secret },
    ],
    hint: 'Set the content type to application/json and send only the Issues event.',
  }
  void refresh()
}

function onRuleSaved(): void {
  editingRule.value = null
  void refresh()
}

function openRule(id: string): void {
  const rule = rules.value.find((r) => r.id === id)
  if (rule) editingRule.value = { rule }
}

function revokeIngest(id: string, name: string): void {
  void confirm({
    title: 'Revoke endpoint',
    message:
      'Anything still posting to this URL stops working immediately. Cards it already created are kept.',
    subject: name,
    confirmLabel: 'Revoke endpoint',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      try {
        await api.revokeIngestToken(id)
        await Promise.all([refresh(), ws.refresh()])
        toast.success('Endpoint revoked')
      } catch (err) {
        toast.error(humanise(err), { title: 'Revoke failed' })
      }
    },
  })
}

function deleteRule(id: string, name: string): void {
  void confirm({
    title: 'Delete rule',
    message: 'It stops running immediately. This cannot be undone.',
    subject: name,
    confirmLabel: 'Delete rule',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      try {
        const { results } = await api.ruleWrite([
          { op: 'delete', op_id: opId(), id },
        ])
        const bad = results.find((r) => !r.ok)
        if (bad) throw new Error((bad as { error: string }).error)
        await refresh()
        toast.success('Rule deleted')
      } catch (err) {
        toast.error(humanise(err), { title: 'Delete failed' })
      }
    },
  })
}
</script>

<style scoped lang="scss">
.automation {
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

  &__reveal {
    display: flex;
    gap: var(--nb-spacing-8);
    align-items: end;
  }

  &__hint {
    margin-block-start: var(--nb-spacing-8);
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

  &__agent {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__actions {
    display: flex;
    gap: var(--nb-spacing-4);
    justify-content: end;
  }

  /* An endpoint nothing has ever posted to is the one safe to remove, so the
     word carries a little less weight than a date rather than more. */
  &__never {
    color: var(--nb-c-text-subtle);
  }
}
</style>
