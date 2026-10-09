<template>
  <HomePanelFrame
    title="Needs your attention"
    info="What colleagues did this week on cards you hold, created or have commented on, one line per card with the latest change. Your own changes are left out, and so are mentions, which Next up already ranks."
    :loading="loading"
    :empty="!data || data.entries.length === 0"
    empty-title="Quiet on your cards"
    empty-text="When somebody comments on, moves or changes a card you are on, it shows here."
  >
    <ul v-if="data" class="home-rows">
      <li v-for="entry in data.entries" :key="entry.key">
        <button
          type="button"
          class="home-row"
          @click="inspector.open(entry.key)"
        >
          <span class="home-row__main">
            <span class="home-row__title">
              <span class="home-row__key">{{ entry.key }}</span>
              <span>{{ entry.title }}</span>
            </span>
            <span class="home-row__line">
              {{ entry.actor_name.split(' ')[0] }} {{ sentence(entry.summary) }}
              <template v-if="entry.more > 0">
                and {{ entry.more }} more</template
              >
            </span>
          </span>
          <span
            v-nb-tooltip="{ body: new Date(entry.at).toLocaleString() }"
            class="home-row__line"
            tabindex="0"
          >
            {{ relativeTime(entry.at) }}
          </span>
        </button>
      </li>
    </ul>
  </HomePanelFrame>
</template>

<script setup lang="ts">
import { api } from '@/api/client'
import { relativeTime } from '@/lib/state'
import { useInspector } from '@/stores/workspace'
import { useHomePanelData } from '@/composables/useHomePanelData'
import HomePanelFrame from '@/components/home/HomePanelFrame.vue'

const inspector = useInspector()
const { data, loading } = useHomePanelData(() => api.myAttention(), ['item'])

/** Event summaries name the card ("commented on ST-1"); the row already does. */
function sentence(summary: string): string {
  // "commented on ST-1" -> "commented", "moved ST-1 to Done" -> "moved to Done".
  return summary.replace(/\s+(?:on\s+)?[A-Z][A-Z0-9]*-\d+\b/, '').trim()
}
</script>

<style scoped lang="scss">
@use './homeRows.scss';
</style>
