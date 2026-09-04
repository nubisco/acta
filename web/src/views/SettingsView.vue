<template>
  <div class="settings">
    <h1>Settings</h1>

    <NbTabs v-model="tab" :items="tabs">
      <template #members>
        <section class="settings__section">
          <h2>Members and agents</h2>
          <NbDataTable
            :columns="actorColumns"
            :rows="actorRows"
            row-key="handle"
          />
          <div v-if="ws.isAdmin.value" class="settings__row">
            <NbButton variant="primary" size="sm" @click="creatingToken = true"
              >New agent token</NbButton
            >
          </div>
          <NbBanner v-if="freshToken" status="warning" variant="callout">
            Copy this token now; it is shown once: <code>{{ freshToken }}</code>
          </NbBanner>
        </section>
      </template>

      <template #labels>
        <section class="settings__section">
          <h2>Labels</h2>
          <div
            v-for="group in labelGroups"
            :key="group.name"
            class="settings__labels"
          >
            <h3>
              {{ group.name }}
              <small v-if="group.board">({{ group.board }})</small>
            </h3>
            <div class="settings__chips">
              <NbLabel
                v-for="label in group.labels"
                :key="label.id"
                :text="label.name"
              />
            </div>
          </div>
        </section>
      </template>

      <template #webhooks>
        <section class="settings__section">
          <h2>Webhooks</h2>
          <NbDataTable
            :columns="webhookColumns"
            :rows="webhookRows"
            row-key="url"
          />
          <NbButton variant="primary" size="sm" @click="creatingWebhook = true"
            >New webhook</NbButton
          >
        </section>
      </template>

      <template #rules>
        <section class="settings__section">
          <h2>Rules</h2>
          <NbDataTable :columns="ruleColumns" :rows="ruleRows" row-key="name" />
          <p class="settings__hint">
            Rules are created via the API or MCP (<code>rule_write</code>); this
            list is the audit surface.
          </p>
        </section>
      </template>

      <template #ingest>
        <section class="settings__section">
          <h2>Ingest tokens</h2>
          <p class="settings__hint">
            Ingest tokens let external forms post items directly:
            <code>POST /api/v1/ingest/&lt;token&gt;</code>.
          </p>
          <NbButton
            v-if="ws.isAdmin.value"
            variant="primary"
            size="sm"
            @click="creatingIngest = true"
          >
            New ingest token
          </NbButton>
          <NbBanner v-if="freshIngestToken" status="warning" variant="callout">
            Copy this token now; it is shown once:
            <code>{{ freshIngestToken }}</code>
          </NbBanner>
        </section>
      </template>
    </NbTabs>

    <TextPromptModal
      :open="creatingToken"
      title="New agent token"
      submit-label="Create token"
      :fields="[
        { name: 'name', label: 'Agent name', placeholder: 'Claude Code' },
        { name: 'scopes', label: 'Scopes', initial: 'read,write' },
      ]"
      @close="creatingToken = false"
      @submit="createToken"
    />
    <TextPromptModal
      :open="creatingWebhook"
      title="New webhook"
      submit-label="Create webhook"
      :fields="[
        { name: 'url', label: 'URL', placeholder: 'https://example.com/hook' },
        {
          name: 'events',
          label: 'Event patterns (comma-separated)',
          initial: 'item.*',
        },
        { name: 'secret', label: 'HMAC secret (optional)', optional: true },
      ]"
      @close="creatingWebhook = false"
      @submit="createWebhook"
    />
    <TextPromptModal
      :open="creatingIngest"
      title="New ingest token"
      submit-label="Create token"
      :fields="[
        { name: 'name', label: 'Source name', placeholder: 'Contact form' },
        { name: 'board', label: 'Board key', placeholder: 'SUP' },
        { name: 'list', label: 'List (optional)', optional: true },
      ]"
      @close="creatingIngest = false"
      @submit="createIngest"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  NbBanner,
  NbButton,
  NbDataTable,
  NbLabel,
  NbTabs,
  useToast,
} from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'
import TextPromptModal from '@/components/TextPromptModal.vue'

const ws = useWorkspace()
const toast = useToast()

const tab = ref('members')
const tabs = [
  { id: 'members', label: 'Members' },
  { id: 'labels', label: 'Labels' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'rules', label: 'Rules' },
  { id: 'ingest', label: 'Ingest' },
]

const creatingToken = ref(false)
const creatingWebhook = ref(false)
const creatingIngest = ref(false)
const freshToken = ref('')
const freshIngestToken = ref('')

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
      labels: { id: string; name: string; color: string }[]
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
    groups
      .get(key)!
      .labels.push({ id: label.id, name: label.name, color: label.color })
  }
  return [...groups.values()]
})

const webhookRows = ref<Record<string, unknown>[]>([])
const webhookColumns = [
  { key: 'url', header: 'URL' },
  { key: 'events', header: 'Events' },
  { key: 'status', header: 'Status' },
]

const ruleRows = ref<Record<string, unknown>[]>([])
const ruleColumns = [
  { key: 'name', header: 'Name' },
  { key: 'trigger', header: 'Trigger' },
  { key: 'condition', header: 'Condition' },
  { key: 'status', header: 'Status' },
]

onMounted(refreshLists)

async function refreshLists(): Promise<void> {
  const [webhooks, rules] = await Promise.all([api.webhooks(), api.rules()])
  webhookRows.value = webhooks.webhooks.map((w) => ({
    url: w.url,
    events: w.events.join(', '),
    status: w.enabled
      ? w.failures > 0
        ? `${w.failures} failures`
        : 'active'
      : 'disabled',
  }))
  ruleRows.value = rules.rules.map((r) => ({
    name: r.name,
    trigger: r.trigger,
    condition: r.condition ?? '',
    status: r.enabled ? 'enabled' : 'disabled',
  }))
}

async function createToken(values: Record<string, string>): Promise<void> {
  creatingToken.value = false
  try {
    const res = await api.createAgentToken(
      values.name,
      values.scopes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    freshToken.value = res.token
    await ws.refresh()
  } catch (err) {
    toast.error(String(err))
  }
}

async function createWebhook(values: Record<string, string>): Promise<void> {
  creatingWebhook.value = false
  const { results } = await api.webhookWrite([
    {
      op: 'create',
      op_id: newOpId(),
      url: values.url,
      events: values.events
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      secret: values.secret || undefined,
    },
  ])
  if (!results[0].ok)
    toast.error(String((results[0] as { error: string }).error))
  await refreshLists()
}

async function createIngest(values: Record<string, string>): Promise<void> {
  creatingIngest.value = false
  try {
    const res = await api.createIngestToken(
      values.name,
      values.board,
      values.list || undefined,
    )
    freshIngestToken.value = res.token
  } catch (err) {
    toast.error(String(err))
  }
}
</script>

<style scoped lang="scss">
.settings {
  display: grid;
  gap: calc(var(--nb-base-unit) * 2);
  align-content: start;

  &__section {
    display: grid;
    gap: calc(var(--nb-base-unit) * 2);
    padding-top: calc(var(--nb-base-unit) * 2);
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--nb-base-unit) / 2);
  }

  &__hint {
    font-size: 0.85rem;
    opacity: 0.7;
  }

  &__row {
    display: flex;
    gap: var(--nb-base-unit);
  }
}
</style>
