<template>
  <div class="report">
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
          hint="Off, the report is the plain version built from the facts. The provider and its key are in the AI briefings tab."
          control="fit"
        >
          <span class="report__ai-control">
            <NbSwitch
              v-model="config.aiWriting"
              name="report-ai"
              label="Written by the AI provider"
              hide-label
            />
            <NbAiLabel static size="sm" />
          </span>
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

    <div class="report__aside">
      <NbPanel class="report__section">
        <header>
          <h2 class="type-heading-01">Preview</h2>
          <p class="report__lede">
            Today's report, written now from everything since the last one. A
            preview posts nothing and does not count as a report, so it can be
            run as often as you like. A test posts the same preview to the
            webhook, marked as a test.
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
            <template v-if="previewed.writer === 'ai'">
              <NbAiLabel static size="sm" variant="inline" />
              Written by the AI provider.
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
  </div>
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
</script>

<style scoped lang="scss">
.report {
  display: grid;
  // The settings on the left, the preview and past reports beside them, so a
  // change and its effect are on one screen. One column below 75rem.
  grid-template-columns: minmax(0, 48rem) minmax(24rem, 1fr);
  gap: var(--nb-spacing-16);
  align-items: start;

  @media (max-width: 75rem) {
    grid-template-columns: minmax(0, 1fr);
  }

  &__aside {
    display: grid;
    gap: var(--nb-spacing-16);
    min-inline-size: 0;
  }

  &__ai-control {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

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
