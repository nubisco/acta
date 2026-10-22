<template>
  <div class="ai">
    <div class="ai__top">
      <NbAiProvider
        v-model:model="model"
        v-model:api-key="apiKey"
        :provider="provider"
        :default-models="defaults"
        :has-key="ai?.hasKey ?? false"
        :busy="busy"
        @update:provider="provider = $event as TAiProvider"
        @save="saveAi"
        @remove="removeKey"
      >
        <p>
          Bring your own provider key, the same as Analytics and Verba. Nubisco
          never supplies one and never charges for tokens: every request is
          billed by your provider, to this key. What is sent is what the report
          is about: card keys and titles, goal titles and statuses, and people's
          handles. Never descriptions or comments.
        </p>
      </NbAiProvider>
      <NbAiUsage
        :has-key="ai?.hasKey ?? false"
        :days="usage?.days ?? 30"
        requests-label="Reports written"
        :requests="usage?.requests ?? 0"
        :input-tokens="usage?.inputTokens ?? 0"
        :output-tokens="usage?.outputTokens ?? 0"
        :estimated-cost-usd="usage?.estimatedCostUsd ?? null"
        :unpriced-models="usage?.unpricedModels ?? []"
        :pricing-verified-on="usage?.pricingVerifiedOn ?? ''"
      />
    </div>

    <h2 class="type-heading-02 ai__subhead">Briefings</h2>
    <SettingsDailyReport />
  </div>
</template>

<script setup lang="ts">
/**
 * AI briefings: the workspace's provider, what it has cost, and every
 * briefing Acta runs with it (the daily report). Admin only.
 *
 * Built only from @nubisco/ui's NbAiProvider, NbAiUsage and NbBriefing, the
 * same as Analytics' tab. AGENTS.md ("AI briefings") is the standard.
 */
import { onMounted, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import {
  api,
  type IAiSettings,
  type IAiUsage,
  type TAiProvider,
} from '@/api/client'
import { humanise } from '@/lib/state'
import SettingsDailyReport from './SettingsDailyReport.vue'

const toast = useToast()

const ai = ref<IAiSettings | null>(null)
const usage = ref<IAiUsage | null>(null)
const defaults = ref<Partial<Record<TAiProvider, string>>>({})
const provider = ref<TAiProvider>('anthropic')
const model = ref('')
const apiKey = ref('')
const busy = ref(false)

function applyAi(settings: IAiSettings): void {
  ai.value = settings
  provider.value = settings.provider
  model.value = settings.model ?? ''
  apiKey.value = ''
}

async function load(): Promise<void> {
  try {
    const res = await api.aiSettings()
    applyAi(res.settings)
    usage.value = res.usage
    defaults.value = res.defaults
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not load the AI settings' })
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
    toast.success('AI settings saved')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not save the AI settings' })
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
</script>

<style scoped lang="scss">
.ai {
  display: grid;
  gap: var(--nb-spacing-16);

  // The provider and what it has cost side by side on a desktop.
  &__top {
    display: grid;
    grid-template-columns: minmax(0, 44rem) minmax(20rem, 1fr);
    gap: var(--nb-spacing-16);
    align-items: start;

    @media (max-width: 75rem) {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  &__subhead {
    margin: var(--nb-spacing-8) 0 0;
  }
}
</style>
