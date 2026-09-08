<template>
  <div class="settings">
    <h1 class="type-heading-03">Settings</h1>

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
        <template #cell-handle="{ row }">
          <span class="settings__member">
            <ActorAvatar :handle="row.rawHandle" />
            <span>{{ row.handle }}</span>
          </span>
        </template>
        <template #cell-kind="{ row }">
          <NbAiLabel v-if="row.kind === 'agent'" />
          <NbBadge v-else-if="row.kind === 'system'" size="sm" variant="grey">
            System
          </NbBadge>
          <NbBadge v-else size="sm" variant="blue">Member</NbBadge>
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
      <NbPanel
        v-for="group in labelGroups"
        :key="`${group.name}:${group.board ?? ''}`"
        class="settings__labels"
      >
        <div class="settings__labels-head">
          <h2 class="type-heading-01">{{ group.name }}</h2>
          <NbBadge v-if="group.board" size="sm" variant="grey">
            {{ boardName(group.board) }}
          </NbBadge>
          <NbBadge v-else size="sm" variant="grey">Workspace</NbBadge>
          <span class="settings__scope">
            {{ group.labels.length }}
            {{ group.labels.length === 1 ? 'label' : 'labels' }}
          </span>
          <NbButton
            v-if="ws.isAdmin.value"
            size="xs"
            variant="ghost"
            @click="toggleManage(group)"
          >
            {{ managing === groupKey(group) ? 'Done' : 'Manage' }}
          </NbButton>
        </div>

        <div v-if="managing !== groupKey(group)" class="settings__chips">
          <NbBadge
            v-for="label in group.labels"
            :key="label.id"
            size="md"
            :variant="variants.get(label.name) ?? 'grey'"
          >
            {{ label.name }}
          </NbBadge>
        </div>

        <div v-else class="settings__label-editor">
          <div
            v-for="label in group.labels"
            :key="label.id"
            class="settings__label-row"
          >
            <NbBadge size="md" :variant="variants.get(label.name) ?? 'grey'">
              {{ label.name }}
            </NbBadge>
            <NbInlineEdit
              :model-value="label.name"
              label="Label name"
              @commit="(name: string) => renameLabel(label, name)"
            />
            <NbSelect
              :id="`field-label-color-${label.id}`"
              :model-value="label.color"
              size="sm"
              :options="colorOptions"
              aria-label="Label color"
              @update:model-value="
                (color) => recolorLabel(label, String(color ?? ''))
              "
            />
            <NbSelect
              :id="`field-label-merge-${label.id}`"
              model-value=""
              size="sm"
              :options="mergeOptions(group, label)"
              placeholder="Merge into..."
              aria-label="Merge into another label"
              @update:model-value="
                (target) => mergeLabel(label, String(target ?? ''), group)
              "
            />
            <NbButton
              size="xs"
              variant="danger"
              outlined
              icon="trash-simple"
              :aria-label="`Delete label ${label.name}`"
              @click="deleteLabel(label)"
            />
          </div>
          <form
            class="settings__label-create"
            @submit.prevent="createLabel(group)"
          >
            <NbTextInput
              :id="`field-label-new-${groupKey(group)}`"
              v-model="newLabelName"
              size="sm"
              placeholder="New label name..."
              aria-label="New label name"
            />
            <NbSelect
              :id="`field-label-new-color-${groupKey(group)}`"
              v-model="newLabelColor"
              size="sm"
              :options="colorOptions"
              aria-label="New label color"
            />
            <NbButton
              type="submit"
              size="sm"
              variant="secondary"
              :disabled="!newLabelName.trim()"
            >
              Add label
            </NbButton>
          </form>
        </div>
      </NbPanel>
      <NbEmptyState
        v-if="labelGroups.length === 0"
        size="sm"
        title="No labels yet"
        description="Labels are created on boards or through imports and can be managed here."
      />
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

    <section v-if="tab === 'connections'" class="settings__section">
      <NbBanner
        v-if="freshConnection"
        status="info"
        variant="inline"
        title="Add these to the repository's webhook settings now; the secret is shown once"
        dismissible
        @close="freshConnection = null"
      >
        <NbField v-slot="{ id }" label="Payload URL" orientation="stack">
          <div class="settings__token">
            <NbTextInput
              :id="id"
              :model-value="connectionUrl"
              readonly
              size="sm"
            />
            <NbButton
              size="sm"
              variant="secondary"
              @click="copy(connectionUrl)"
            >
              Copy
            </NbButton>
          </div>
        </NbField>
        <NbField v-slot="{ id }" label="Secret" orientation="stack">
          <div class="settings__token">
            <NbTextInput
              :id="id"
              :model-value="freshConnection.secret"
              readonly
              size="sm"
            />
            <NbButton
              size="sm"
              variant="secondary"
              @click="copy(freshConnection!.secret)"
            >
              Copy
            </NbButton>
          </div>
        </NbField>
        <p class="settings__hint">
          Set the content type to <code>application/json</code> and send only
          the <strong>Issues</strong> event.
        </p>
      </NbBanner>
      <NbDataTable
        :columns="connectionColumns"
        :rows="connectionRows"
        row-key="id"
        size="sm"
        aria-label="Connections"
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
            title="No connections yet"
            description="Connect a GitHub repository and its issues become tracking cards on a board of your choice."
          >
            <template #actions>
              <NbButton
                v-if="ws.isAdmin.value"
                size="xs"
                variant="primary"
                @click="creatingConnection = true"
              >
                Connect GitHub
              </NbButton>
            </template>
          </NbEmptyState>
        </template>
      </NbDataTable>
      <div v-if="ws.isAdmin.value" class="settings__row">
        <NbButton
          size="sm"
          variant="primary"
          @click="creatingConnection = true"
        >
          Connect GitHub
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
    <NewConnectionModal
      :open="creatingConnection"
      @close="creatingConnection = false"
      @created="onConnectionCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useConfirm, useShellSlot, useToast } from '@nubisco/ui'
import { api, newOpId as opId } from '@/api/client'
import { humanise } from '@/lib/state'
import { labelVariants } from '@/lib/labels'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import NewMemberModal from '@/components/NewMemberModal.vue'
import NewTokenModal from '@/components/NewTokenModal.vue'
import NewConnectionModal from '@/components/NewConnectionModal.vue'
import NewWebhookModal from '@/components/NewWebhookModal.vue'

const ws = useWorkspace()
const toast = useToast()
const confirm = useConfirm()
const filterBar = useShellSlot('fixedbar')

const tab = ref('members')
const tabs = [
  { id: 'members', label: 'Members' },
  { id: 'labels', label: 'Labels' },
  { id: 'connections', label: 'Connections' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'rules', label: 'Rules' },
  { id: 'ingest', label: 'Ingest' },
]

const invitingMember = ref(false)
const creatingAgent = ref(false)
const creatingIngest = ref(false)
const creatingWebhook = ref(false)
const creatingConnection = ref(false)
const freshConnection = ref<{ id: string; secret: string } | null>(null)
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
    rawHandle: a.handle,
    name: a.name,
    kind: a.kind,
  })),
)

const variants = computed(() => labelVariants(ws.overview.value))

function boardName(key: string): string {
  return ws.overview.value?.boards.find((b) => b.key === key)?.name ?? key
}

interface ILabelView {
  id: string
  name: string
  color: string
}

interface ILabelGroupView {
  name: string
  board: string | null
  labels: ILabelView[]
}

const labelGroups = computed<ILabelGroupView[]>(() => {
  const groups = new Map<string, ILabelGroupView>()
  for (const label of ws.overview.value?.labels ?? []) {
    const key = `${label.group_name}:${label.board_key ?? ''}`
    if (!groups.has(key))
      groups.set(key, {
        name: label.group_name,
        board: label.board_key,
        labels: [],
      })
    groups.get(key)!.labels.push({
      id: label.id,
      name: label.name,
      color: label.color,
    })
  }
  return [...groups.values()]
})

// -- Label management -------------------------------------------------------

const managing = ref<string | null>(null)
const newLabelName = ref('')
const newLabelColor = ref('gray')

const colorOptions = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'lime',
  'blue',
  'sky',
  'purple',
  'pink',
  'black',
].map((c) => ({ label: c, value: c }))

function groupKey(group: ILabelGroupView): string {
  return `${group.name}:${group.board ?? ''}`
}

function toggleManage(group: ILabelGroupView): void {
  managing.value = managing.value === groupKey(group) ? null : groupKey(group)
  newLabelName.value = ''
}

function mergeOptions(group: ILabelGroupView, label: ILabelView) {
  return group.labels
    .filter((l) => l.id !== label.id)
    .map((l) => ({ label: l.name, value: l.id }))
}

async function runLabelOps(
  ops: Parameters<typeof api.labelWrite>[0],
  failure: string,
): Promise<void> {
  try {
    const { results } = await api.labelWrite(ops)
    const bad = results.find((r) => !r.ok)
    if (bad) throw new Error((bad as { error: string }).error)
    await ws.refresh()
  } catch (err) {
    toast.error(humanise(err), { title: failure })
  }
}

function renameLabel(label: ILabelView, name: string): void {
  const trimmed = name.trim()
  if (!trimmed || trimmed === label.name) return
  void runLabelOps(
    [{ op: 'label_update', op_id: opId(), label: label.id, name: trimmed }],
    'Rename failed',
  )
}

function recolorLabel(label: ILabelView, color: string): void {
  if (!color || color === label.color) return
  void runLabelOps(
    [{ op: 'label_update', op_id: opId(), label: label.id, color }],
    'Color change failed',
  )
}

function mergeLabel(
  label: ILabelView,
  targetId: string,
  group: ILabelGroupView,
): void {
  if (!targetId) return
  const target = group.labels.find((l) => l.id === targetId)
  if (!target) return
  void confirm({
    title: 'Merge labels',
    message: `Every item labeled "${label.name}" gets "${target.name}" instead, and "${label.name}" is deleted.`,
    subject: `${label.name} → ${target.name}`,
    confirmLabel: 'Merge labels',
    cancelLabel: 'Keep both',
    onConfirm: () =>
      void runLabelOps(
        [{ op: 'label_merge', op_id: opId(), from: label.id, into: target.id }],
        'Merge failed',
      ),
  })
}

function deleteLabel(label: ILabelView): void {
  void confirm({
    title: 'Delete label',
    message: 'It is removed from every item that carries it.',
    subject: label.name,
    confirmLabel: 'Delete label',
    cancelLabel: 'Keep it',
    onConfirm: () =>
      void runLabelOps(
        [{ op: 'label_delete', op_id: opId(), label: label.id }],
        'Delete failed',
      ),
  })
}

function createLabel(group: ILabelGroupView): void {
  const name = newLabelName.value.trim()
  if (!name) return
  void runLabelOps(
    [
      {
        op: 'label_create',
        op_id: opId(),
        group: group.name,
        name,
        color: newLabelColor.value,
      },
    ],
    'Create failed',
  )
  newLabelName.value = ''
}

const listsLoading = ref(true)
const listsError = ref('')

interface IWebhookRowView {
  id: string
  url: string
  destination: string
  events: string
  failures: number
  status: string
  statusVariant: 'green' | 'grey' | 'orange'
  statusDot: boolean
}

const webhookRows = ref<IWebhookRowView[]>([])
const webhookColumns = [
  { key: 'url', header: 'URL' },
  { key: 'destination', header: 'Destination' },
  { key: 'events', header: 'Events' },
  { key: 'status', header: 'Status' },
  { key: 'failures', header: 'Failures' },
]

interface IConnectionRowView {
  id: string
  name: string
  provider: string
  target: string
  status: string
  statusVariant: 'green' | 'grey' | 'orange'
  statusDot: boolean
}

const connectionRows = ref<IConnectionRowView[]>([])
const connectionColumns = [
  { key: 'name', header: 'Name' },
  { key: 'provider', header: 'Provider' },
  { key: 'target', header: 'Creates cards in' },
  { key: 'status', header: 'Status' },
]

/**
 * The endpoint to paste into GitHub. Built from the browser's own origin so
 * it is right for a self-hosted instance without any configuration.
 */
const connectionUrl = computed(() =>
  freshConnection.value
    ? `${window.location.origin}/api/v1/hooks/github/${freshConnection.value.id}`
    : '',
)

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
    const [webhooks, rules, connections] = await Promise.all([
      api.webhooks(),
      api.rules(),
      api.connections(),
    ])
    connectionRows.value = connections.connections.map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      target: c.list ? `${c.board} · ${c.list}` : c.board,
      status: !c.enabled
        ? 'Inactive'
        : c.last_error
          ? 'Attention'
          : c.last_event_at
            ? 'Active'
            : 'Waiting',
      statusVariant: !c.enabled ? 'grey' : c.last_error ? 'orange' : 'green',
      statusDot: c.enabled,
    }))
    webhookRows.value = webhooks.webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      destination: w.format === 'slack' ? 'Slack' : 'Signed JSON',
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

function onConnectionCreated(payload: { id: string; secret: string }): void {
  creatingConnection.value = false
  freshConnection.value = payload
  void refreshLists()
}

function onWebhookCreated(): void {
  creatingWebhook.value = false
  void refreshLists()
}

async function copyToken(): Promise<void> {
  await navigator.clipboard.writeText(freshToken.value)
  toast.success('Token copied')
}

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  toast.success('Copied')
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
    justify-items: stretch;
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

    /* These values are copied, and a truncated one reads as the whole
     * string. Let the field take the row so the endpoint and the secret are
     * legible without selecting them. */
    > :first-child {
      flex: 1;
      min-inline-size: 0;
    }
  }

  &__hint {
    margin-block: var(--nb-spacing-8) 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-muted);
  }

  &__labels {
    display: grid;
    gap: var(--nb-spacing-12);
    justify-self: stretch;
    border-radius: var(--nb-radius-md);
  }

  &__labels-head {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);

    h2 {
      margin: 0;
    }
  }

  &__member {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__label-editor {
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__label-row {
    display: grid;
    grid-template-columns: 9rem minmax(0, 1fr) 8rem 10rem auto;
    gap: var(--nb-spacing-8);
    align-items: center;
  }

  &__label-create {
    display: flex;
    gap: var(--nb-spacing-8);
    padding-block-start: var(--nb-spacing-8);
    border-block-start: 1px solid var(--nb-c-border);

    > :first-child {
      flex: 1;
      max-inline-size: 20rem;
    }
  }

  &__scope {
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-subtle);
    margin-inline-start: auto;
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
