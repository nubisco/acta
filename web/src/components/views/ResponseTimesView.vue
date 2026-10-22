<template>
  <NbDataTable
    stack-on-phone
    size="sm"
    title="Response times"
    :description="description"
    aria-label="Response times"
    :columns="columns"
    :rows="rows"
    row-key="id"
    :loading="load.state.value === 'loading'"
    :error="load.state.value === 'error' ? load.message.value : undefined"
  >
    <template #toolbar-actions>
      <!-- Fluid: the label sits inside the box, so the toolbar keeps one
           row and the control still says what it is. -->
      <NbSelect
        v-model="period"
        size="sm"
        variant="fluid"
        label="Period"
        :options="PERIODS"
      />
    </template>
    <template #cell-name="{ row }">
      <LabelBadge
        v-if="(row as IRow).labelId"
        :id="(row as IRow).labelId"
        :name="(row as IRow).name"
        qualify
      />
      <strong v-else>{{ (row as IRow).name }}</strong>
    </template>
    <template #empty>
      <NbEmptyState
        size="sm"
        title="Nothing to measure"
        description="No cards arrived, were answered or were resolved in this period."
      />
    </template>
    <template #footer>
      <!-- The definitions, said where the numbers are, because "response"
           means something different on every team. -->
      <p class="response-times__note">
        First response is the first comment or move by a person other than
        whoever filed the card. Agents and automations never count. Resolution
        is reaching a done list or being completed. Times run from when the card
        was created, in calendar hours.
      </p>
    </template>
  </NbDataTable>
</template>

<script setup lang="ts">
/**
 * How long people wait in this space: time to first response and time to
 * resolution, for the space as a whole and for each label on its cards
 * (LA-370). Computed by the server from the event log, the same report the
 * MCP tool `response_times` returns.
 */
import { computed, ref, watch } from 'vue'
import type { IDataTableColumn } from '@nubisco/ui'
import { api } from '@/api/client'
import { useLoadState } from '@/lib/state'
import type { IResponseStats, IResponseTimes } from '@/types/api'
import LabelBadge from '@/components/LabelBadge.vue'
import {
  PERIODS,
  formatDuration,
  periodRange,
  rangeText,
  type TPeriod,
} from '@/lib/responseTimes'

const props = defineProps<{ spaceKey: string }>()

interface IRow extends Record<string, unknown> {
  id: string
  name: string
  labelId?: string
  received: number
  unanswered: number
  answered: number
  first_median: string
  first_p90: string
  resolved: number
  resolution_median: string
  resolution_p90: string
}

const period = ref<TPeriod>('this-week')
const report = ref<IResponseTimes | null>(null)
const load = useLoadState()

async function reload(): Promise<void> {
  const result = await load.run(
    api.responseTimes({
      space: props.spaceKey,
      ...periodRange(period.value, Date.now()),
    }),
  )
  if (result) report.value = result
}
watch([() => props.spaceKey, period], reload, { immediate: true })

const description = computed(() =>
  report.value ? rangeText(report.value.from, report.value.to) : undefined,
)

function toRow(id: string, name: string, stats: IResponseStats): IRow {
  return {
    id,
    name,
    received: stats.received,
    unanswered: stats.unanswered,
    answered: stats.first_response.count,
    first_median: formatDuration(stats.first_response.median_ms),
    first_p90: formatDuration(stats.first_response.p90_ms),
    resolved: stats.resolution.count,
    resolution_median: formatDuration(stats.resolution.median_ms),
    resolution_p90: formatDuration(stats.resolution.p90_ms),
  }
}

/**
 * The space first, then each label in its group's order. A space where
 * nothing happened gets no rows at all, so the empty state says so rather
 * than a row of zeroes.
 */
const rows = computed<IRow[]>(() => {
  const space = report.value?.spaces[0]
  if (!space) return []
  const all = space.all
  if (
    all.received === 0 &&
    all.first_response.count === 0 &&
    all.resolution.count === 0
  )
    return []
  return [
    toRow('all', 'All cards', all),
    ...space.labels.map((label) => ({
      ...toRow(label.id, label.name, label),
      labelId: label.id,
    })),
  ]
})

const columns: IDataTableColumn<IRow>[] = [
  { key: 'name', header: 'Cards', primary: true },
  { key: 'received', header: 'Received', align: 'right' },
  { key: 'unanswered', header: 'Waiting', align: 'right' },
  { key: 'answered', header: 'Answered', align: 'right' },
  { key: 'first_median', header: 'First response, median', align: 'right' },
  { key: 'first_p90', header: 'First response, P90', align: 'right' },
  { key: 'resolved', header: 'Resolved', align: 'right' },
  { key: 'resolution_median', header: 'Resolution, median', align: 'right' },
  { key: 'resolution_p90', header: 'Resolution, P90', align: 'right' },
]
</script>

<style scoped lang="scss">
.response-times__note {
  margin: 0;
  padding: var(--nb-spacing-8) var(--nb-spacing-12);
  font-size: var(--nb-type-body-sm-size);
  color: var(--nb-c-text-subtle);
}
</style>
