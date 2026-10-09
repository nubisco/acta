<template>
  <HomePanelFrame
    title="Document updates"
    info="Pages somebody else changed in the last two weeks that concern you: pages you own, have commented on, or are named in. A page you own also says how many of its comment threads are still open."
    :loading="loading"
    :empty="!data || data.docs.length === 0"
    empty-title="No page changed under you"
    empty-text="When someone edits a page you own, have commented on or are named in, it shows here."
  >
    <ul v-if="data" class="home-rows">
      <li v-for="doc in data.docs" :key="doc.slug">
        <RouterLink class="home-row" :to="wpath(`/docs/${doc.slug}`)">
          <span class="home-row__main">
            <span class="home-row__title"
              ><span>{{ doc.title }}</span></span
            >
            <span class="home-row__line">
              {{ doc.by ? `${doc.by.split(' ')[0]} edited it` : 'Edited' }}
              {{ relativeTime(doc.updated).toLowerCase() }} · {{ WHY[doc.why] }}
            </span>
          </span>
          <NbBadge v-if="doc.open_comments" size="sm" variant="blue">
            {{ doc.open_comments }} open
            {{ doc.open_comments === 1 ? 'thread' : 'threads' }}
          </NbBadge>
        </RouterLink>
      </li>
    </ul>
  </HomePanelFrame>
</template>

<script setup lang="ts">
import { api } from '@/api/client'
import { relativeTime } from '@/lib/state'
import { wpath } from '@/lib/paths'
import { useHomePanelData } from '@/composables/useHomePanelData'
import HomePanelFrame from '@/components/home/HomePanelFrame.vue'

const { data, loading } = useHomePanelData(() => api.myDocs(), ['doc'])

const WHY = {
  owner: 'your page',
  named: 'you are named in it',
  commented: 'you commented on it',
} as const
</script>

<style scoped lang="scss">
@use './homeRows.scss';
</style>
