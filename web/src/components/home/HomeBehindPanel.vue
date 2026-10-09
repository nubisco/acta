<template>
  <HomePanelFrame
    title="Falling behind"
    info="What is slipping in the spaces you work in, whoever holds it: cards past their due date, cards in progress that nobody has moved for a week, and goals still in flight past their target date."
    :loading="loading"
    :empty="total === 0"
    empty-title="Nothing is slipping"
    empty-text="Late cards, stalled work and goals past their date in your spaces show up here."
  >
    <template v-if="data">
      <template v-if="data.late.length">
        <h3 class="home-subhead">Past their date</h3>
        <ul class="home-rows">
          <li v-for="card in data.late" :key="card.key">
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
                  >{{ card.space }} · {{ holdersOf(card.holders) }}</span
                >
              </span>
              <NbBadge size="sm" variant="red"
                >{{ plural(card.days_late, 'day') }} late</NbBadge
              >
            </button>
          </li>
        </ul>
      </template>
      <template v-if="data.stuck.length">
        <h3 class="home-subhead">Stalled in progress</h3>
        <ul class="home-rows">
          <li v-for="card in data.stuck" :key="card.key">
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
                  >{{ card.space }} · {{ holdersOf(card.holders) }}</span
                >
              </span>
              <NbBadge size="sm" variant="orange"
                >Untouched {{ plural(card.idle_days, 'day') }}</NbBadge
              >
            </button>
          </li>
        </ul>
      </template>
      <template v-if="data.goals.length">
        <h3 class="home-subhead">Goals past their date</h3>
        <ul class="home-rows">
          <li v-for="goal in data.goals" :key="goal.key">
            <RouterLink class="home-row" :to="wpath(`/goals/${goal.number}`)">
              <span class="home-row__main">
                <span class="home-row__title">
                  <span class="home-row__key">{{ goal.key }}</span>
                  <span>{{ goal.title }}</span>
                </span>
                <span class="home-row__line">{{
                  goalStatus(goal.status).label
                }}</span>
              </span>
              <NbBadge size="sm" variant="red"
                >{{ plural(goal.days_late, 'day') }} late</NbBadge
              >
            </RouterLink>
          </li>
        </ul>
      </template>
    </template>
  </HomePanelFrame>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { api } from '@/api/client'
import { goalStatus } from '@/lib/goals'
import { wpath } from '@/lib/paths'
import { useInspector, useWorkspace } from '@/stores/workspace'
import { useHomePanelData } from '@/composables/useHomePanelData'
import HomePanelFrame from '@/components/home/HomePanelFrame.vue'

const inspector = useInspector()
const ws = useWorkspace()
const { data, loading } = useHomePanelData(
  () => api.myBehind(),
  ['item', 'goal'],
)

const total = computed(() =>
  data.value
    ? data.value.late.length + data.value.stuck.length + data.value.goals.length
    : 0,
)
const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : `${word}s`}`
function holdersOf(handles: string[]): string {
  if (handles.length === 0) return 'Nobody on it'
  const names = handles.map(
    (h) =>
      ws.overview.value?.actors
        .find((a) => a.handle === h)
        ?.name.split(' ')[0] ?? h,
  )
  return names.join(', ')
}
</script>

<style scoped lang="scss">
@use './homeRows.scss';
</style>
