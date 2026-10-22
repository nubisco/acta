<template>
  <div class="ai">
    <NbPanel class="ai__section">
      <header>
        <h2 class="type-heading-01 ai__title">
          AI briefings <NbAiLabel static size="sm" />
        </h2>
        <p class="ai__lede">
          Bring your own provider key, the same as Analytics and Verba. Nubisco
          never supplies one and never charges for tokens: every request is
          billed by your provider, to this key. What is sent is what the report
          is about: card keys and titles, goal titles and statuses, and people's
          handles. Never descriptions or comments.
        </p>
      </header>

      <div class="ai__form">
        <div class="ai__row">
          <NbField v-slot="{ id }" label="Provider" orientation="stack">
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
            orientation="stack"
            hint="Empty uses the provider's default."
          >
            <NbTextInput
              :id="id"
              v-model="model"
              :placeholder="defaults[provider] ?? ''"
              :disabled="busy"
            />
          </NbField>
        </div>
        <NbField
          v-slot="{ id }"
          label="API key"
          orientation="stack"
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
        <p class="ai__meta">
          Used by the daily report, when "Written by the AI provider" is on in
          the Daily report tab.
        </p>
      </div>

      <div class="ai__actions">
        <NbButton variant="primary" :loading="busy" @click="saveAi">
          Save AI settings
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
    </NbPanel>

    <NbPanel class="ai__section">
      <header>
        <h2 class="type-heading-01">Usage and cost</h2>
        <p class="ai__lede">
          What this workspace has asked your provider for over the last
          {{ usage?.days ?? 30 }} days. Your provider bills you directly, so
          these are our records, not an invoice: check the provider console for
          the authoritative figure.
        </p>
      </header>
      <p v-if="!ai?.hasKey" class="ai__meta">
        No key yet, so nothing has been sent to a provider. Usage appears here
        once reports are written.
      </p>
      <NbDefinitionList v-else-if="usage" :items="usageItems" dividers />
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
/**
 * The workspace's AI provider and what it has cost. Admin only.
 *
 * The same tab as Analytics' AI briefings, by design: same name, same AI mark
 * in the title, provider and model on one row, the key below, and usage beside
 * it in the same rows and order. AGENTS.md ("AI settings panel") makes this
 * the standard, so change both together.
 */
import { computed, onMounted, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import {
  api,
  type IAiSettings,
  type IAiUsage,
  type TAiProvider,
} from '@/api/client'
import { humanise } from '@/lib/state'

const PROVIDER_OPTIONS = [
  { label: 'Anthropic (Claude)', value: 'anthropic' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Google Gemini', value: 'gemini' },
]

const toast = useToast()

const ai = ref<IAiSettings | null>(null)
const usage = ref<IAiUsage | null>(null)
const defaults = ref<Partial<Record<TAiProvider, string>>>({})
const provider = ref<TAiProvider>('anthropic')
const model = ref('')
const apiKey = ref('')
const busy = ref(false)

const usageItems = computed(() => {
  const u = usage.value
  if (!u) return []
  return [
    {
      term: 'Reports written',
      value: `${u.requests.toLocaleString()} (requests that reached your provider)`,
    },
    {
      term: 'Tokens',
      value: `${formatTokens(u.inputTokens + u.outputTokens)} (${formatTokens(u.inputTokens)} in, ${formatTokens(u.outputTokens)} out)`,
    },
    {
      term: 'Estimated cost',
      value:
        u.estimatedCostUsd === null
          ? `n/a: no published price on file for ${u.unpricedModels.join(', ')}`
          : `${formatUsd(u.estimatedCostUsd)} at list prices as of ${u.pricingVerifiedOn}`,
    },
  ]
})

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

/** The same rounding as Analytics, so the two tabs read the same figure alike. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}
</script>

<style scoped lang="scss">
.ai {
  display: grid;
  // Settings and their usage side by side on a desktop, as in Analytics.
  grid-template-columns: minmax(0, 44rem) minmax(20rem, 1fr);
  gap: var(--nb-spacing-16);
  align-items: start;

  @media (max-width: 75rem) {
    grid-template-columns: minmax(0, 1fr);
  }

  &__section {
    display: grid;
    gap: var(--nb-spacing-16);
  }

  &__title {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__lede {
    margin: var(--nb-spacing-4) 0 0;
    max-inline-size: 70ch;
    color: var(--nb-c-text-muted);
  }

  &__form {
    display: grid;
    gap: var(--nb-spacing-12);
  }

  &__row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--nb-spacing-12);
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
}
</style>
