<template>
  <div class="report">
    <NbPanel class="report__section">
      <header>
        <h2 class="type-heading-01">AI provider</h2>
        <p class="report__lede">
          Bring your own provider key, the same as Analytics and Verba. Nubisco
          never supplies one and never charges for tokens: every request is
          billed by your provider, to this key. What is sent is what the report
          is about: card keys and titles, goal titles and statuses, and people's
          handles. Never descriptions or comments.
        </p>
      </header>

      <div class="report__form">
        <NbField v-slot="{ id }" label="Provider">
          <NbSelect
            :id="id"
            v-model="provider"
            :options="PROVIDER_OPTIONS"
            :disabled="busy"
          />
        </NbField>
        <NbField
          v-slot="{ id }"
          label="Model"
          hint="Empty uses the provider's default."
        >
          <NbTextInput
            :id="id"
            v-model="model"
            :placeholder="defaults[provider] ?? ''"
            :disabled="busy"
          />
        </NbField>
        <NbField
          v-slot="{ id }"
          label="API key"
          hint="Encrypted at rest and never sent back to the browser, so this field is always empty when the page loads."
        >
          <NbTextInput
            :id="id"
            v-model="apiKey"
            type="password"
            autocomplete="off"
            :placeholder="
              ai?.hasKey ? 'Stored. Type a new key to replace it.' : 'sk-...'
            "
            :disabled="busy"
          />
        </NbField>
      </div>

      <div class="report__actions">
        <NbButton variant="primary" :loading="busy" @click="saveAi">
          Save provider
        </NbButton>
        <NbButton
          v-if="ai?.hasKey"
          variant="ghost"
          :disabled="busy"
          @click="removeKey"
        >
          Remove key
        </NbButton>
      </div>

      <p v-if="usage && usage.requests > 0" class="report__usage">
        Last {{ usage.days }} days: {{ usage.requests }}
        {{ usage.requests === 1 ? 'request' : 'requests' }},
        {{ formatTokens(usage.inputTokens + usage.outputTokens) }} tokens,
        <template v-if="usage.estimatedCostUsd !== null">
          about {{ formatUsd(usage.estimatedCostUsd) }} at list prices as of
          {{ usage.pricingVerifiedOn }}.
        </template>
        <template v-else>
          no published price on file for
          {{ usage.unpricedModels.join(', ') }}.
        </template>
        Check your provider's console for the real figure.
      </p>
    </NbPanel>

    <NbPanel class="report__section">
      <header>
        <h2 class="type-heading-01">Daily report</h2>
        <p class="report__lede">
          Once a working day, one Slack message: what was finished since the
          last report, what that opened up and for whom, where each goal stands,
          and a few focus points for each person. Everything in it is worked out
          by Acta from its own data. The AI provider only writes the sentences,
          and its version is checked before it is used: if it names a card, a
          goal or a person the facts do not contain, the plain version goes out
          instead. Nothing is posted on a day nothing moved.
        </p>
      </header>

      <div class="report__form">
        <NbField label="Send the report" control="fit">
          <NbSwitch
            v-model="config.enabled"
            name="report-enabled"
            label="Send the report"
            hide-label
          />
        </NbField>
        <NbRadio
          v-model="config.mode"
          name="report-mode"
          label="Where it goes"
          :options="MODE_OPTIONS"
        />
        <NbField
          v-slot="{ id }"
          label="Slack webhook"
          hint="An incoming webhook for one channel. Start with a private test channel, then paste the #general one here when the report reads well."
        >
          <NbTextInput
            :id="id"
            v-model="webhook"
            type="password"
            autocomplete="off"
            :placeholder="
              config.hasWebhook
                ? 'Stored. Paste a new one to replace it.'
                : 'https://hooks.slack.com/services/...'
            "
          />
        </NbField>
        <NbField v-slot="{ id }" label="Time">
          <NbSelect :id="id" v-model="sendHour" :options="HOUR_OPTIONS" />
        </NbField>
        <NbField v-slot="{ id }" label="Time zone">
          <NbTextInput :id="id" v-model="config.timezone" />
        </NbField>
        <NbField label="Weekdays only" control="fit">
          <NbSwitch
            v-model="config.weekdaysOnly"
            name="report-weekdays"
            label="Weekdays only"
            hide-label
          />
        </NbField>
        <NbField
          v-slot="{ id }"
          label="Days off"
          hint="Dates with no report, as YYYY-MM-DD, separated by commas."
        >
          <NbTextInput
            :id="id"
            v-model="holidays"
            placeholder="2026-12-24, 2026-12-25"
          />
        </NbField>
        <NbField
          v-slot="{ id }"
          label="Waiting after"
          hint="A card holding up another is named once nobody has touched it for this many days."
        >
          <NbNumberInput
            :id="id"
            v-model="config.stallDays"
            :min="1"
            :max="60"
          />
        </NbField>
        <NbField
          label="Written by the AI provider"
          hint="Off, the report is the plain version built from the facts."
          control="fit"
        >
          <NbSwitch
            v-model="config.aiWriting"
            name="report-ai"
            label="Written by the AI provider"
            hide-label
          />
        </NbField>
      </div>

      <h3 class="type-heading-02 report__subhead">Slack member ids</h3>
      <p class="report__lede">
        So a person's block mentions them and Slack notifies them. In Slack,
        open their profile, then More, then Copy member ID. Without one, the
        report uses their name.
      </p>
      <div class="report__form">
        <NbField
          v-for="person in humans"
          :key="person.handle"
          v-slot="{ id }"
          :label="person.name"
        >
          <NbTextInput
            :id="id"
            v-model="slackIds[person.handle]"
            placeholder="U012ABCDEF"
          />
        </NbField>
      </div>

      <div class="report__actions">
        <NbButton variant="primary" :loading="busy" @click="saveReport">
          Save report settings
        </NbButton>
      </div>
    </NbPanel>

    <NbPanel class="report__section">
      <header>
        <h2 class="type-heading-01">Preview</h2>
        <p class="report__lede">
          Today's report, written now from everything since the last one. A
          preview posts nothing and does not count as a report, so it can be run
          as often as you like. A test posts the same preview to the webhook,
          marked as a test.
        </p>
      </header>
      <div class="report__actions">
        <NbButton variant="secondary" :loading="previewing" @click="preview">
          Preview now
        </NbButton>
        <NbButton
          variant="ghost"
          :disabled="!config.hasWebhook || previewing"
          @click="sendTest"
        >
          Send a test to Slack
        </NbButton>
      </div>
      <template v-if="previewed">
        <p class="report__meta">
          {{
            previewed.writer === 'ai'
              ? 'Written by the AI provider.'
              : 'The plain version.'
          }}
          <template v-if="previewed.fallbackReason">
            {{ previewed.fallbackReason }}
          </template>
          <template v-if="previewed.empty">
            Nothing moved since the last report, so the scheduled one would post
            nothing.
          </template>
        </p>
        <pre class="report__text">{{ previewed.text }}</pre>
      </template>
    </NbPanel>

    <NbPanel v-if="runs.length > 0" class="report__section">
      <header>
        <h2 class="type-heading-01">Recent reports</h2>
      </header>
      <details v-for="run in runs" :key="run.id" class="report__run">
        <summary>
          {{ run.runDate }}: {{ STATUS_LABELS[run.status] }}
          <template v-if="run.writer">
            ({{ run.writer === 'ai' ? 'AI' : 'plain' }})</template
          >
        </summary>
        <p v-if="run.error" class="report__meta">{{ run.error }}</p>
        <pre v-if="run.text" class="report__text">{{ run.text }}</pre>
      </details>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
/**
 * The daily progress report (LA-389) and the AI provider it writes with.
 * Admin only. The provider settings mirror Analytics' AI briefings, because
 * they are the same deal: the workspace's key, never ours.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import {
  api,
  type IAiSettings,
  type IAiUsage,
  type IDailyReportConfig,
  type IDailyReportPreview,
  type IDailyReportRun,
  type TAiProvider,
} from '@/api/client'
import { useWorkspace } from '@/stores/workspace'
import { humanise } from '@/lib/state'

const PROVIDER_OPTIONS = [
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Google Gemini', value: 'gemini' },
]
const MODE_OPTIONS = [
  { label: 'Keep it here as a preview, post nothing', value: 'preview' },
  { label: 'Post it to Slack', value: 'post' },
]
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  label: `${String(h).padStart(2, '0')}:00`,
  value: String(h),
}))
const STATUS_LABELS: Record<IDailyReportRun['status'], string> = {
  pending: 'writing',
  posted: 'posted',
  preview: 'kept as a preview',
  skipped: 'nothing to report',
  failed: 'failed',
}

const ws = useWorkspace()
const toast = useToast()

const humans = computed(() =>
  (ws.overview.value?.actors ?? []).filter((a) => a.kind === 'human'),
)

const ai = ref<IAiSettings | null>(null)
const usage = ref<IAiUsage | null>(null)
const defaults = ref<Partial<Record<TAiProvider, string>>>({})
const provider = ref<TAiProvider>('anthropic')
const model = ref('')
const apiKey = ref('')

const config = reactive<IDailyReportConfig>({
  enabled: false,
  mode: 'preview',
  hasWebhook: false,
  sendHour: 9,
  timezone: 'Europe/Lisbon',
  weekdaysOnly: true,
  holidays: [],
  stallDays: 5,
  slackIds: {},
  aiWriting: true,
})
const webhook = ref('')
const holidays = ref('')
const slackIds = reactive<Record<string, string>>({})
/** NbSelect speaks strings, the setting is a number. */
const sendHour = computed({
  get: () => String(config.sendHour),
  set: (value: string) => (config.sendHour = Number(value)),
})

const runs = ref<IDailyReportRun[]>([])
const previewed = ref<IDailyReportPreview | null>(null)
const busy = ref(false)
const previewing = ref(false)

function applyAi(settings: IAiSettings): void {
  ai.value = settings
  provider.value = settings.provider
  model.value = settings.model ?? ''
  apiKey.value = ''
}

function applyConfig(next: IDailyReportConfig): void {
  Object.assign(config, next)
  holidays.value = next.holidays.join(', ')
  for (const key of Object.keys(slackIds)) delete slackIds[key]
  Object.assign(slackIds, next.slackIds)
  webhook.value = ''
}

async function load(): Promise<void> {
  try {
    const [aiRes, reportRes] = await Promise.all([
      api.aiSettings(),
      api.dailyReport(),
    ])
    applyAi(aiRes.settings)
    usage.value = aiRes.usage
    defaults.value = aiRes.defaults
    applyConfig(reportRes.config)
    runs.value = reportRes.runs
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not load the report settings' })
  }
}
onMounted(load)

async function saveAi(): Promise<void> {
  busy.value = true
  try {
    const res = await api.setAiSettings({
      provider: provider.value,
      model: model.value.trim() || null,
      ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
    })
    applyAi(res.settings)
    toast.success('Provider saved')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not save the provider' })
  } finally {
    busy.value = false
  }
}

async function removeKey(): Promise<void> {
  busy.value = true
  try {
    applyAi((await api.setAiSettings({ apiKey: null })).settings)
    toast.success('Key removed. The report will use the plain version.')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not remove the key' })
  } finally {
    busy.value = false
  }
}

async function saveReport(): Promise<void> {
  busy.value = true
  try {
    const res = await api.setDailyReport({
      enabled: config.enabled,
      mode: config.mode,
      sendHour: config.sendHour,
      timezone: config.timezone.trim(),
      weekdaysOnly: config.weekdaysOnly,
      holidays: holidays.value
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
      stallDays: Number(config.stallDays),
      slackIds: { ...slackIds },
      aiWriting: config.aiWriting,
      ...(webhook.value.trim()
        ? { slackWebhookUrl: webhook.value.trim() }
        : {}),
    })
    applyConfig(res.config)
    toast.success('Report settings saved')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not save the report settings' })
  } finally {
    busy.value = false
  }
}

async function preview(): Promise<void> {
  previewing.value = true
  try {
    previewed.value = await api.previewDailyReport()
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not write the preview' })
  } finally {
    previewing.value = false
  }
}

async function sendTest(): Promise<void> {
  previewing.value = true
  try {
    previewed.value = await api.testDailyReport()
    toast.success('Test posted to Slack')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not post the test' })
  } finally {
    previewing.value = false
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function formatUsd(n: number): string {
  return n < 0.01 ? 'under $0.01' : `$${n.toFixed(2)}`
}
</script>

<style scoped lang="scss">
.report {
  display: grid;
  gap: var(--nb-spacing-16);

  &__section {
    display: grid;
    gap: var(--nb-spacing-16);
  }

  &__lede {
    margin: var(--nb-spacing-4) 0 0;
    max-inline-size: 70ch;
    color: var(--nb-c-text-muted);
  }

  &__subhead {
    margin: var(--nb-spacing-8) 0 0;
  }

  &__form {
    display: grid;
    gap: var(--nb-spacing-12);
    max-inline-size: 44rem;
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--nb-spacing-8);
  }

  &__usage,
  &__meta {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-muted);
  }

  &__text {
    margin: 0;
    padding: var(--nb-spacing-12);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    background: var(--nb-c-layer-01, transparent);
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  &__run summary {
    cursor: pointer;
    padding-block: var(--nb-spacing-4);
  }
}
</style>
