<template>
  <HomePanelFrame
    title="Where you left off"
    info="The cards you changed most recently, newest first, so you can pick up where you stopped."
    :loading="loading"
    :empty="!data || data.recent.length === 0"
    empty-title="Nothing yet"
    empty-text="Cards you change show up here."
  >
    <ul v-if="data" class="home-rows">
      <li v-for="card in data.recent" :key="card.key">
        <button
          type="button"
          class="home-row"
          @click="inspector.open(card.key)"
        >
          <span class="home-row__main">
            <span class="home-row__title">
              <span class="home-row__key">{{ card.key }}</span>
              <span>{{ card.title }}</span>
            </span>
            <span class="home-row__line"
              >{{ card.space }} · {{ card.list }}</span
            >
          </span>
          <span v-if="card.at" class="home-row__line">{{
            relativeTime(card.at)
          }}</span>
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
const { data, loading } = useHomePanelData(() => api.myWork(), ['item'])
</script>

<style scoped lang="scss">
@use './homeRows.scss';
</style>
