<template>
  <div class="home">
    <h1>{{ ws.overview.value?.workspace.name ?? 'Workspace' }}</h1>

    <NbEmptyState
      v-if="boards.length === 0"
      title="No boards yet"
      description="Create your first board to start tracking work."
    >
      <NbButton variant="primary" @click="createBoard">New board</NbButton>
    </NbEmptyState>

    <NbCardGrid v-else>
      <NbCard
        v-for="board in boards"
        :key="board.key"
        class="home__card"
        @click="router.push(`/b/${board.key}`)"
      >
        <header>
          <strong>{{ board.name }}</strong>
          <NbBadge>{{ board.key }}</NbBadge>
        </header>
        <ul class="home__lists">
          <li v-for="list in board.lists" :key="list.id">
            <span>{{ list.name }}</span>
            <span class="home__count">{{ list.items }}</span>
          </li>
        </ul>
      </NbCard>
      <NbCard class="home__card home__card--new" @click="createBoard">
        <NbIcon name="plus" />
        <span>New board</span>
      </NbCard>
    </NbCardGrid>

    <section v-if="recent.length > 0" class="home__activity">
      <h2>Recent activity</h2>
      <ActivityList :events="recent" />
    </section>

    <TextPromptModal
      :open="creating"
      title="New board"
      :fields="[
        { name: 'name', label: 'Name', placeholder: 'Stagewright' },
        {
          name: 'key',
          label: 'Key (2-5 uppercase letters)',
          placeholder: 'SW',
        },
      ]"
      @close="creating = false"
      @submit="submitBoard"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NbBadge,
  NbButton,
  NbCard,
  NbCardGrid,
  NbEmptyState,
  NbIcon,
  useToast,
} from '@nubisco/ui'
import { api, newOpId, type IEventRow } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'
import ActivityList from '@/components/ActivityList.vue'
import TextPromptModal from '@/components/TextPromptModal.vue'

const ws = useWorkspace()
const router = useRouter()
const toast = useToast()

const boards = computed(() =>
  (ws.overview.value?.boards ?? []).filter((b) => !b.archived),
)
const recent = ref<IEventRow[]>([])

onMounted(async () => {
  const { events } = await api.activity({ limit: '15' })
  recent.value = events
})

const creating = ref(false)

function createBoard(): void {
  creating.value = true
}

async function submitBoard(values: Record<string, string>): Promise<void> {
  creating.value = false
  const key = values.key.toUpperCase().trim()
  const { results } = await api.boardWrite([
    {
      op: 'create',
      op_id: newOpId(),
      key,
      name: values.name,
      template: 'kanban6',
    },
  ])
  if (results[0].ok) {
    await ws.refresh()
    void router.push(`/b/${key}`)
  } else {
    toast.error(String((results[0] as { error: string }).error))
  }
}
</script>

<style scoped lang="scss">
.home {
  display: grid;
  gap: calc(var(--nb-base-unit) * 3);

  &__card {
    cursor: pointer;

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--nb-base-unit);
    }
  }

  &__card--new {
    display: grid;
    place-items: center;
    gap: var(--nb-base-unit);
    color: var(--nb-c-text-muted, inherit);
  }

  &__lists {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: calc(var(--nb-base-unit) / 2);

    li {
      display: flex;
      justify-content: space-between;
      font-size: 0.85rem;
    }
  }

  &__count {
    opacity: 0.6;
  }

  &__activity h2 {
    margin-bottom: var(--nb-base-unit);
  }
}
</style>
