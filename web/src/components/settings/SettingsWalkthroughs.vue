<template>
  <div class="walkthroughs">
    <NbPanel class="walkthroughs__section">
      <header>
        <h2 class="type-heading-01">Walkthroughs</h2>
        <p class="walkthroughs__lede">
          Each walkthrough plays once, the first time you reach the part of Acta
          it explains. Reset one and it plays again the next time that happens,
          or play it now.
        </p>
      </header>

      <ul class="walkthroughs__list">
        <li
          v-for="entry in WALKTHROUGHS"
          :key="entry.name"
          class="walkthroughs__row"
        >
          <div class="walkthroughs__what">
            <span class="walkthroughs__title">{{ entry.title }}</span>
            <span class="walkthroughs__desc">{{ entry.description }}</span>
          </div>
          <NbBadge
            v-nb-tooltip="{ body: stateOf(entry).tip }"
            size="sm"
            :variant="stateOf(entry).variant"
            class="walkthroughs__state"
          >
            {{ stateOf(entry).text }}
          </NbBadge>
          <span class="walkthroughs__actions">
            <NbButton
              v-nb-tooltip="{
                body: `Plays ${entry.plays}`,
              }"
              size="sm"
              variant="ghost"
              icon="arrow-counter-clockwise"
              :disabled="!records[entry.walkthrough.id] || busy === entry.name"
              @click="reset(entry.name, entry.walkthrough.id)"
            >
              Reset
            </NbButton>
            <NbButton
              size="sm"
              variant="secondary"
              icon="play"
              @click="play(entry.name)"
            >
              Play now
            </NbButton>
          </span>
        </li>
      </ul>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
/**
 * Every walkthrough, whether this person has been through it, and a way to
 * meet it again (Jose, 2026-10-08). The state is on the account, so it reads
 * the same in every browser.
 */
import { nextTick, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { IWalkthroughRecord } from '@nubisco/ui'
import { useToast } from '@nubisco/ui'
import { WALKTHROUGHS, type TTourName } from '@/lib/tour'
import { useTours } from '@/lib/tours'
import { wpath } from '@/lib/paths'
import { useWorkspace } from '@/stores/workspace'

const tours = useTours()
const router = useRouter()
const ws = useWorkspace()
const toast = useToast()

const records = reactive<Record<string, IWalkthroughRecord | null>>({})
const busy = ref<TTourName | null>(null)

async function refresh(): Promise<void> {
  for (const entry of WALKTHROUGHS) {
    const id = entry.walkthrough.id
    records[id] = (await tours.storage.get(id)) ?? null
  }
}

onMounted(refresh)

type TBadge = 'grey' | 'green' | 'blue' | 'orange'

function stateOf(entry: (typeof WALKTHROUGHS)[number]): {
  text: string
  tip: string
  variant: TBadge
} {
  const record = records[entry.walkthrough.id]
  if (!record)
    return {
      text: 'Not seen',
      tip: `Plays ${entry.plays}`,
      variant: 'blue',
    }
  const when = new Date(record.completedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  if (record.version < entry.walkthrough.version)
    return {
      text: 'Updated',
      tip: `It has changed since you saw it on ${when}, so it plays ${entry.plays}`,
      variant: 'orange',
    }
  return record.outcome === 'finish'
    ? { text: 'Seen', tip: `Finished on ${when}`, variant: 'green' }
    : { text: 'Skipped', tip: `Skipped on ${when}`, variant: 'grey' }
}

async function reset(name: TTourName, id: string): Promise<void> {
  busy.value = name
  try {
    await tours.controllers[name].reset()
    records[id] = null
    const entry = WALKTHROUGHS.find((w) => w.name === name)
    toast.success(`It plays ${entry?.plays ?? 'again'}.`)
  } finally {
    busy.value = null
  }
}

/**
 * Take the reader to where the walkthrough points, then start it. The intro
 * needs a space and the goals one the goals page, or most of their steps
 * would have nothing on screen to point at and be dropped.
 */
async function play(name: TTourName): Promise<void> {
  if (name === 'intro') {
    const space = ws.overview.value?.spaces[0]
    if (space) await router.push(wpath(`/s/${space.key}`))
  } else if (name === 'goals') {
    await router.push(wpath('/goals'))
  }
  await nextTick()
  // A page arriving with its data a moment later is what the library's one
  // retry frame cannot wait for, so give it a beat.
  if (name !== 'notifications') await new Promise((r) => setTimeout(r, 400))
  await tours.controllers[name].restart()
}
</script>

<style scoped lang="scss">
.walkthroughs {
  display: grid;
  gap: var(--nb-spacing-24);
}

.walkthroughs__section {
  display: grid;
  gap: var(--nb-spacing-16);
}

.walkthroughs__lede {
  margin: var(--nb-spacing-4) 0 0;
  color: var(--nb-c-text-muted);
  max-inline-size: 60ch;
}

.walkthroughs__list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.walkthroughs__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--nb-spacing-16);
  padding-block: var(--nb-spacing-12);

  & + & {
    border-block-start: 1px solid var(--nb-c-border);
  }

  @media (max-width: 640px) {
    grid-template-columns: minmax(0, 1fr) auto;

    .walkthroughs__actions {
      grid-column: 1 / -1;
    }
  }
}

.walkthroughs__what {
  display: grid;
  gap: var(--nb-spacing-2, 2px);
  min-inline-size: 0;
}

.walkthroughs__title {
  font-weight: var(--nb-font-weight-semibold, 600);
}

.walkthroughs__desc {
  color: var(--nb-c-text-muted);
  font-size: var(--nb-type-body-sm-size);
}

.walkthroughs__actions {
  display: inline-flex;
  gap: var(--nb-spacing-8);
}
</style>
