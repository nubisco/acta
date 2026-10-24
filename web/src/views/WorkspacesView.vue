<template>
  <div class="workspaces" :class="{ 'workspaces--framed': framed }">
    <header class="workspaces__header">
      <NbNubiscoMark v-if="!framed" class="workspaces__mark" />
      <h1 class="type-heading-03">
        {{ framed ? 'Workspaces' : 'Choose a workspace' }}
      </h1>
    </header>

    <NbBanner
      v-if="error"
      status="error"
      variant="inline"
      :title="error"
      class="workspaces__banner"
    />

    <div v-if="loading" class="workspaces__loading">
      <NbSkeleton variant="block" height="6rem" />
      <NbSkeleton variant="block" height="6rem" />
    </div>

    <NbEmptyState
      v-else-if="workspaces.length === 0"
      size="sm"
      title="No workspaces yet"
      :description="
        canCreate
          ? 'Create one of your own, or ask an admin to invite you to theirs.'
          : 'This account is not a member of any workspace. Ask an admin to invite you.'
      "
    >
      <template v-if="canCreate" #actions>
        <NbButton variant="primary" icon="plus" :to="{ name: 'signup' }">
          Create a workspace
        </NbButton>
      </template>
    </NbEmptyState>

    <NbCardGrid v-else min="16rem" class="workspaces__grid">
      <NbCard
        v-for="workspace in workspaces"
        :key="workspace.id"
        clickable
        :selected="isCurrent(workspace)"
        :title="workspace.name"
        :subtitle="`/${workspace.slug}`"
        :data-workspace="workspace.slug"
        @select="choose(workspace)"
      >
        <template #icon>
          <NbAvatar :name="workspace.name" size="md" decorative />
        </template>
        <template v-if="isCurrent(workspace)" #footer>
          <NbBadge size="sm" variant="primary">Current</NbBadge>
        </template>
      </NbCard>
    </NbCardGrid>

    <!-- Signup (EE): only where the instance offers it, and within the
         per-account cap. Above it, the way to more is sales. -->
    <footer
      v-if="
        !loading && workspaces.length > 0 && signup && signup.open !== false
      "
      class="workspaces__more"
    >
      <NbButton
        v-if="signup.can_create"
        variant="secondary"
        icon="plus"
        :to="{ name: 'signup' }"
      >
        Create a workspace
      </NbButton>
      <p v-else-if="signup.sales_url" class="workspaces__note">
        Need another workspace?
        <a :href="signup.sales_url" target="_blank" rel="noopener"
          >Contact sales</a
        >.
      </p>
    </footer>
  </div>
</template>

<script setup lang="ts">
/**
 * Every workspace this person belongs to, and the one place to switch.
 *
 * Two ways in. Before any workspace is chosen it is the entry point, outside
 * the frame, and a single workspace (the common case) never makes anyone
 * choose: it redirects straight through. From the rail's Workspaces entry,
 * with a workspace already open, it is a page inside the frame and always
 * lists, because bouncing someone who asked for the list back to where they
 * came from would look like the entry did nothing. App.vue frames it on the
 * same condition.
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { auth, type ISignupState } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace, type IWorkspaceSummary } from '@/stores/workspace'

const router = useRouter()
const route = useRoute()
const ws = useWorkspace()

const framed = computed(() => ws.workspaceSlug.value !== '')

function isCurrent(workspace: IWorkspaceSummary): boolean {
  return workspace.slug === ws.workspaceSlug.value
}

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

function choose(workspace: IWorkspaceSummary): void {
  void router.push(destinationIn(workspace))
}

const workspaces = ref<IWorkspaceSummary[]>([])
const loading = ref(true)
const error = ref('')
/** Null where the instance has no signup, or before it is known. */
const signup = ref<ISignupState | null>(null)
const canCreate = computed(() => signup.value?.can_create === true)

async function loadSignup(): Promise<void> {
  await ws.loadAuthConfig()
  if (!ws.signupEnabled.value) return
  try {
    signup.value = await auth.signupState()
  } catch {
    // No button rather than a broken one.
    signup.value = null
  }
}

async function load(): Promise<void> {
  try {
    if (!ws.me.value && !(await ws.loadMe())) {
      void router.replace({ name: 'login', query: { to: '/' } })
      return
    }
    workspaces.value = await ws.listWorkspaces()
    if (!framed.value && workspaces.value.length === 1) {
      void router.replace(destinationIn(workspaces.value[0]))
      return
    }
    await loadSignup()
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
  align-content: center;
  justify-items: center;
  gap: var(--nb-spacing-16);
  min-block-size: 100vh;
  padding: var(--nb-spacing-24);

  &__header {
    display: grid;
    gap: var(--nb-spacing-16);
    justify-items: center;
    text-align: center;
  }

  &__mark {
    inline-size: 2.5rem;
  }

  h1 {
    margin: 0;
  }

  &__banner,
  &__loading,
  &__grid,
  &__more {
    inline-size: min(40rem, 100%);
  }

  &__note {
    margin: 0;
    color: var(--nb-c-text-subtle);
  }

  &__loading {
    display: grid;
    gap: var(--nb-spacing-8);
  }

  // Inside the frame it is an ordinary page: a heading at the top, the
  // cards under it, nothing centred in the viewport.
  &--framed {
    align-content: start;
    justify-items: stretch;
    min-block-size: 0;
    padding: 0;

    .workspaces__header {
      justify-items: start;
      text-align: start;
    }

    .workspaces__banner,
    .workspaces__loading,
    .workspaces__grid,
    .workspaces__more {
      inline-size: 100%;
    }
  }
}
</style>
