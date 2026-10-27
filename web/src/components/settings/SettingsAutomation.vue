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

    <!--
      A modal rather than a banner at the top of the page: the secret is shown
      once, and a user scrolled down to the section they just used never saw a
      banner above the fold. It stays until dismissed with Done or the close
      button, and a stray click on the overlay does not lose it.
    -->
    <NbModal
      close-appearance="button"
      :open="fresh !== null"
      :title="fresh?.title ?? ''"
      size="sm"
      :close-on-overlay="false"
      @close="dismissFresh"
    >
      <template v-if="fresh">
        <NbField
          v-for="field in fresh.fields"
          :key="field.label"
          v-slot="{ id }"
          :label="field.label"
          orientation="stack"
        >
          <div class="automation__reveal">
            <NbTextInput
              :id="id"
              :model-value="field.value"
              readonly
              size="sm"
            />
            <NbButton
              size="sm"
              variant="secondary"
              :icon="copyState[field.label] === 'copied' ? 'check' : undefined"
              :data-copy="field.label"
              @click="copy(field.label, field.value)"
            >
              {{ copyLabel(field.label) }}
            </NbButton>
          </div>
        </NbField>
        <p v-if="fresh.hint" class="automation__hint">{{ fresh.hint }}</p>
      </template>
      <template #footer>
        <NbButton variant="primary" @click="dismissFresh">Done</NbButton>
      </template>
    </NbModal>

    <!-- Inbound, unauthenticated senders ------------------------------- -->
    <NbDataTable
      v-if="space"
      stack-on-phone
      :columns="ingestColumns"
      :rows="ingestRows"
      row-key="id"
      size="sm"
      :loading="loading"
      :error="error"
      title="Ingest endpoints"
      description="A URL you paste into a website form or another tool. Anything posted to it becomes a card on this space. The URL is the credential, so treat it as a secret."
    >
      <template #toolbar-actions>
        <NbButton
          v-if="ws.isAdmin.value"
          variant="primary"
          icon="plus"
          @click="creatingIngest = true"
        >
          New endpoint
        </NbButton>
      </template>
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

    <!-- Inbound, signed providers -------------------------------------- -->
    <NbDataTable
      v-if="space"
      stack-on-phone
      :columns="connectionColumns"
      :rows="connectionRows"
      row-key="id"
      size="sm"
      :loading="loading"
      :error="error"
      title="Connections"
      description="A provider pushes signed events to Acta. GitHub issues become tracking cards on this space, and every delivery is verified against a shared secret."
    >
      <template #toolbar-actions>
        <NbButton
          v-if="ws.isAdmin.value"
          variant="primary"
          icon="plus"
          @click="creatingConnection = true"
        >
          Connect GitHub
        </NbButton>
      </template>
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

    <!-- Outbound ------------------------------------------------------- -->
    <NbDataTable
      v-if="!space"
      stack-on-phone
      :columns="webhookColumns"
      :rows="webhookRows"
      row-key="id"
      size="sm"
      :loading="loading"
      :error="error"
      title="Webhooks"
      description="The other direction. Acta posts signed events to your systems as work changes, or to a Slack channel."
    >
      <template #toolbar-actions>
        <NbButton
          v-if="ws.isAdmin.value"
          variant="primary"
          icon="plus"
          @click="creatingWebhook = true"
        >
          New webhook
        </NbButton>
      </template>
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

    <!-- Internal ------------------------------------------------------- -->
    <NbDataTable
      stack-on-phone
      :columns="ruleColumns"
      :rows="ruleRows"
      row-key="id"
      size="sm"
      :loading="loading"
      :error="error"
      title="Rules"
      :description="rulesDescription"
    >
      <template #toolbar-actions>
        <NbButton
          v-if="ws.isAdmin.value"
          variant="primary"
          icon="plus"
          @click="editingRule = { rule: null }"
        >
          New rule
        </NbButton>
      </template>
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
            v-nb-tooltip="{ body: `Edit rule ${row.name}` }"
            size="sm"
            variant="ghost"
            icon="pencil-simple"
            :aria-label="`Edit rule ${row.name}`"
            @click="openRule(String(row.id))"
          />
          <NbButton
            v-if="ws.isAdmin.value"
            v-nb-tooltip="{ body: `Delete rule ${row.name}` }"
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

    <!-- Identities ----------------------------------------------------- -->
    <NbDataTable
      v-if="!space"
      stack-on-phone
      :columns="agentColumns"
      :rows="agentRows"
      row-key="id"
      size="sm"
      title="Agent tokens"
      description="A credential for a script or a bot that acts as itself, with its own name in the activity feed. To let a tool act as you instead, use an access token under Your account."
    >
      <template #toolbar-actions>
        <NbButton
          v-if="ws.isAdmin.value"
          variant="primary"
          icon="plus"
          @click="creatingAgent = true"
        >
          New agent token
        </NbButton>
      </template>
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

    <!-- Where the per-space pieces went (2026-10-24). An old link to this
         tab lands here, so it says where to look and goes there. -->
    <NbDataTable
      v-if="!space"
      stack-on-phone
      :columns="spaceColumns"
      :rows="spaceRows"
      row-key="key"
      size="sm"
      :loading="loading"
      title="For one space"
      description="Ingest endpoints, connections and rules that file cards into one space are in that space's Settings, under Automation."
    >
      <template #cell-actions="{ row }">
        <NbButton
          size="sm"
          variant="ghost"
          icon="sliders-horizontal"
          :to="wpath(`/s/${row.key}/settings?tab=automation`)"
        >
          Open
        </NbButton>
      </template>
      <template #empty>
        <NbEmptyState
          size="sm"
          title="Nothing set up for one space"
          description="Open a space's Settings to add an ingest endpoint, a connection or a rule for it."
        />
      </template>
    </NbDataTable>

    <NewTokenModal
      :open="creatingIngest"
      kind="ingest"
      :locked-space="space ?? undefined"
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
      :locked-space="space ?? undefined"
      @close="creatingConnection = false"
      @created="onConnectionCreated"
    />
    <RuleEditModal
      :open="editingRule !== null"
      :rule="editingRule?.rule ?? null"
      :space="space"
      @close="editingRule = null"
      @saved="onRuleSaved"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * Automation at two levels (2026-10-24). In workspace Settings it is what
 * runs across every space: webhooks, agent tokens and the rules that are not
 * narrowed to a space. In a space's Settings, with `space` set, it is what
 * files cards into that space: its ingest endpoints, its connections and its
 * rules. Each of those rows names exactly one space, so it is shown in that
 * space's Settings and nowhere else.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
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
  ruleSpace,
  type IRuleView,
} from '@/components/settings/rules'
import { wpath } from '@/lib/paths'

const props = defineProps<{
  /** A space's key: show what files cards into it, and nothing else. */
  space?: string
}>()
const space = computed(() => props.space ?? null)

// The Rules table on a space lists what files cards into it, and the
// workspace one lists the rest, so each says which it is.
const rulesDescription = computed(() =>
  space.value
    ? 'Acta reacting to itself. When something happens to a card on this space, and the card matches, do one thing to it. A rule that moves cards here from anywhere is listed here too.'
    : "Acta reacting to itself. When something happens to an item in any space, and the item matches, do one thing to it. A rule narrowed to one space is in that space's Settings.",
)

/**
 * Where a rule is listed. A rule naming a space that no longer exists stays
 * in workspace Settings, or it would be listed nowhere and could never be
 * edited or deleted from the interface again.
 */
function homeOf(rule: IRuleView): string | null {
  const key = ruleSpace(rule)
  return key && ws.overview.value?.spaces.some((s) => s.key === key)
    ? key
    : null
}

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

const spaceColumns = [
  { key: 'name', header: 'Space', primary: true },
  { key: 'ingest', header: 'Ingest endpoints' },
  { key: 'connections', header: 'Connections' },
  { key: 'rules', header: 'Rules' },
  { key: 'actions', header: '' },
]

/** Every space with something of its own, for the pointer above. */
const spaceRows = computed(() =>
  (ws.overview.value?.spaces ?? [])
    .map((s) => ({
      key: s.key,
      name: s.name,
      ingest: ingestTokens.value.filter((t) => t.space === s.key).length,
      connections: connections.value.filter((c) => c.space === s.key).length,
      rules: rules.value.filter((r) => homeOf(r) === s.key).length,
    }))
    .filter((r) => r.ingest + r.connections + r.rules > 0),
)

const ingestRows = computed(() =>
  ingestTokens.value
    .filter((t) => t.space === space.value)
    .map((t) => ({
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
  connections.value
    .filter((c) => c.space === space.value)
    .map((c) => ({
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
  rules.value
    .filter((r) => homeOf(r) === space.value)
    .map((r) => ({
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

const COPIED_MS = 2000
const copyState = ref<Record<string, 'copied' | 'failed'>>({})
const copyTimers = new Map<string, ReturnType<typeof setTimeout>>()

function copyLabel(label: string): string {
  const state = copyState.value[label]
  if (state === 'copied') return 'Copied'
  return state === 'failed' ? 'Copy failed' : 'Copy'
}

/** The button says what happened for a moment, then goes back to "Copy". */
async function copy(label: string, text: string): Promise<void> {
  let state: 'copied' | 'failed' = 'copied'
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    state = 'failed'
  }
  copyState.value = { ...copyState.value, [label]: state }
  clearTimeout(copyTimers.get(label))
  copyTimers.set(
    label,
    setTimeout(() => {
      const rest = { ...copyState.value }
      delete rest[label]
      copyState.value = rest
      copyTimers.delete(label)
    }, COPIED_MS),
  )
}

function dismissFresh(): void {
  fresh.value = null
  copyState.value = {}
}

onBeforeUnmount(() => copyTimers.forEach((t) => clearTimeout(t)))

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
  void refresh()
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
