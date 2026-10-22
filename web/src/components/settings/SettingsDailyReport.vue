<template>
  <NbBriefing
    v-model:enabled="config.enabled"
    v-model:ai-writing="config.aiWriting"
    title="Daily report"
    :status="status"
    :busy="busy"
  >
    <template #description>
      <p>
        Once a working day, one Slack message: what was finished since the last
        report, what that opened up and for whom, where each goal stands, and a
        few focus points for each person. Everything in it is worked out by Acta
        from its own data. AI only writes the sentences, and its version is
        checked before it is used: if it names a card, a goal or a person the
        facts do not contain, the plain version goes out instead. Nothing is
        posted on a day nothing moved.
      </p>
    </template>

    <div class="report__form">
      <NbRadio
        v-model="config.mode"
        name="report-mode"
        label="Each run"
        :options="MODE_OPTIONS"
      />
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
        <NbNumberInput :id="id" v-model="config.stallDays" :min="1" :max="60" />
      </NbField>
    </div>

    <template #destinations>
      <NbBriefingDestination
        kind="slack"
        :summary="config.hasWebhook ? 'Incoming webhook stored' : ''"
        :configured="config.hasWebhook"
        :testing="testing"
        test-label="Send a test to Slack"
        @test="sendTest"
      >
        <div class="report__form">
          <NbField
            v-slot="{ id }"
            label="Webhook"
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
          <p class="report__meta">
            Member ids, so a person's block mentions them and Slack notifies
            them. In Slack, open their profile, then More, then Copy member ID.
            Without one, the report uses their name.
          </p>
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
      </NbBriefingDestination>
    </template>

    <template #actions>
      <NbButton variant="primary" :loading="busy" @click="saveReport">
        Save report settings
      </NbButton>
      <NbButton variant="secondary" :loading="previewing" @click="preview">
        Preview now
      </NbButton>
    </template>

    <template #preview>
      <section class="report__section">
        <h4 class="report__subhead">Preview</h4>
        <p v-if="!previewed" class="report__meta">
          Today's report, written now from everything since the last one. A
          preview posts nothing and does not count as a report, so it can be run
          as often as you like.
        </p>
        <template v-else>
          <p class="report__meta">
            <template v-if="previewed.writer === 'ai'">
              <NbAiLabel static size="sm" variant="inline" />
              Written by AI.
            </template>
            <template v-else>The plain version.</template>
            <template v-if="previewed.fallbackReason">
              {{ previewed.fallbackReason }}
            </template>
            <template v-if="previewed.empty">
              Nothing moved since the last report, so the scheduled one would
              post nothing.
            </template>
          </p>
          <pre class="report__text">{{ previewed.text }}</pre>
        </template>
      </section>
    </template>

    <template v-if="runs.length > 0" #runs>
      <section class="report__section">
        <h4 class="report__subhead">Recent reports</h4>
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
      </section>
    </template>
  </NbBriefing>
</template>

<script setup lang="ts">
/**
 * The daily progress report (LA-389). Admin only. The provider it writes with
 * has its own tab, AI briefings (SettingsAiBriefings.vue), the same as
 * Analytics.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import {
  api,
  type IDailyReportConfig,
  type IDailyReportPreview,
  type IDailyReportRun,
} from '@/api/client'
import { useWorkspace } from '@/stores/workspace'
import { humanise } from '@/lib/state'

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
const testing = ref(false)

/** Beside the title: what the saved settings will do. */
const status = computed(() => {
  if (!config.enabled) return 'Off'
  const at = `${String(config.sendHour).padStart(2, '0')}:00 ${config.timezone}`
  return config.mode === 'post'
    ? `Posts to Slack at ${at}`
    : `Kept here as a preview at ${at}`
})

function applyConfig(next: IDailyReportConfig): void {
  Object.assign(config, next)
  holidays.value = next.holidays.join(', ')
  for (const key of Object.keys(slackIds)) delete slackIds[key]
  Object.assign(slackIds, next.slackIds)
  webhook.value = ''
}

async function load(): Promise<void> {
  try {
    const reportRes = await api.dailyReport()
    applyConfig(reportRes.config)
    runs.value = reportRes.runs
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not load the report settings' })
  }
}
onMounted(load)

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
  testing.value = true
  try {
    previewed.value = await api.testDailyReport()
    toast.success('Test posted to Slack')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not post the test' })
  } finally {
    testing.value = false
  }
}
</script>

<style scoped lang="scss">
.report {
  &__form {
    display: grid;
    gap: var(--nb-spacing-12);
  }

  &__section {
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__subhead {
    margin: 0;
    font-size: var(--nb-type-heading-01-size);
  }

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
