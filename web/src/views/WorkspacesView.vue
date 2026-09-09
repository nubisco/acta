<template>
  <div class="workspaces">
    <NbPanel class="workspaces__panel">
      <NbNubiscoMark class="workspaces__mark" />
      <h1 class="type-heading-03">Choose a workspace</h1>

      <NbBanner
        v-if="error"
        status="error"
        variant="inline"
        :title="error"
        class="workspaces__banner"
      />

      <div v-if="loading" class="workspaces__list">
        <NbSkeleton variant="block" height="3rem" />
        <NbSkeleton variant="block" height="3rem" />
      </div>

      <NbEmptyState
        v-else-if="workspaces.length === 0"
        size="sm"
        title="No workspaces yet"
        description="This account is not a member of any workspace. Ask an admin to add you."
      />

      <ul v-else class="workspaces__list">
        <li v-for="workspace in workspaces" :key="workspace.id">
          <RouterLink class="workspaces__item" :to="destinationIn(workspace)">
            <span class="workspaces__name">{{ workspace.name }}</span>
            <span class="workspaces__slug">/{{ workspace.slug }}</span>
          </RouterLink>
        </li>
      </ul>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
/**
 * The entry point, before any workspace is chosen. A single workspace is the
 * common case and should never make anyone choose, so this redirects straight
 * through and is only ever seen by someone who genuinely has more than one.
 */
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { humanise } from '@/lib/state'
import { useWorkspace, type IWorkspaceSummary } from '@/stores/workspace'

const router = useRouter()
const route = useRoute()
const ws = useWorkspace()

/**
 * Where choosing this workspace should land. A deep link that arrived without
 * a workspace segment kept its path in `?to=`, so the choice resumes the
 * journey instead of dumping you on the home page.
 */
function destinationIn(workspace: IWorkspaceSummary): string {
  const wanted = String(route.query.to ?? '')
  return wanted.startsWith('/')
    ? `/${workspace.slug}${wanted}`
    : `/${workspace.slug}`
}

const workspaces = ref<IWorkspaceSummary[]>([])
const loading = ref(true)
const error = ref('')

async function load(): Promise<void> {
  try {
    if (!ws.me.value && !(await ws.loadMe())) {
      void router.replace({ name: 'login', query: { to: '/' } })
      return
    }
    workspaces.value = await ws.listWorkspaces()
    if (workspaces.value.length === 1) {
      void router.replace(destinationIn(workspaces.value[0]))
      return
    }
  } catch (err) {
    error.value = humanise(err)
  } finally {
    loading.value = false
  }
}

void load()
</script>

<style scoped lang="scss">
.workspaces {
  display: grid;
  place-items: center;
  min-block-size: 100vh;
  padding: var(--nb-spacing-24);

  &__panel {
    inline-size: min(28rem, 100%);
    display: grid;
    gap: var(--nb-spacing-16);
    justify-items: center;
    text-align: center;
  }

  &__mark {
    inline-size: 2.5rem;
  }

  &__banner {
    inline-size: 100%;
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-8);
    inline-size: 100%;
    text-align: start;
  }

  &__item {
    display: flex;
    align-items: baseline;
    gap: var(--nb-spacing-8);
    padding: var(--nb-spacing-12);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm, 8px);
    color: inherit;
    text-decoration: none;

    &:hover {
      border-color: var(--nb-c-primary);
      background: var(--nb-c-surface-hover);
    }
  }

  &__name {
    font-weight: 600;
  }

  &__slug {
    color: var(--nb-c-text-subtle);
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-body-sm-size);
  }
}
</style>
