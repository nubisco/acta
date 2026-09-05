<template>
  <div class="switcher">
    <button
      type="button"
      class="switcher__trigger"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggle"
    >
      <span class="switcher__mark" aria-hidden="true">
        {{ initial }}
      </span>
      <span v-if="!compact" class="switcher__names">
        <span class="switcher__workspace">{{ currentName }}</span>
        <span class="switcher__product">Acta</span>
      </span>
      <NbIcon v-if="!compact" name="caret-up-down" :size="14" />
    </button>
    <NbMenu v-if="open" class="switcher__menu" @close="open = false">
      <NbMenuItem
        v-for="workspace in workspaces"
        :key="workspace.id"
        :label="
          workspace.current ? `${workspace.name} (current)` : workspace.name
        "
        :disabled="workspace.current"
        @click="select(workspace)"
      />
    </NbMenu>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NbIcon, NbMenu, NbMenuItem, useToast } from '@nubisco/ui'
import { api } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'

interface IWorkspaceRow {
  id: string
  name: string
  current: boolean
}

defineProps<{ compact?: boolean }>()

const ws = useWorkspace()
const toast = useToast()
const open = ref(false)
const workspaces = ref<IWorkspaceRow[]>([])

const currentName = computed(
  () => ws.overview.value?.workspace.name ?? 'Workspace',
)
const initial = computed(() => currentName.value.slice(0, 1).toUpperCase())

onMounted(async () => {
  try {
    workspaces.value = (await api.workspaces()).workspaces
  } catch {
    workspaces.value = []
  }
})

function toggle(): void {
  open.value = !open.value
}

function select(workspace: IWorkspaceRow): void {
  open.value = false
  if (workspace.current) return
  // Switching issues a new scoped session; lands with multi-tenant support.
  toast.info('Switching workspaces arrives with multi-tenant support')
}
</script>

<style scoped lang="scss">
.switcher {
  position: relative;

  &__trigger {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    inline-size: 100%;
    background: none;
    border: 0;
    padding: var(--nb-spacing-4);
    border-radius: var(--nb-radius-sm, 8px);
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: start;

    &:hover {
      background: var(--nb-c-surface-hover, rgba(255, 255, 255, 0.06));
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring, var(--nb-c-primary));
      outline-offset: 2px;
    }
  }

  &__mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 28px;
    block-size: 28px;
    border-radius: var(--nb-radius-sm, 8px);
    background: var(--nb-c-primary);
    color: var(--nb-c-primary-a11y, #fff);
    font-weight: var(--nb-type-label-lg-weight, 600);
    flex: none;
  }

  &__names {
    display: grid;
    line-height: 1.2;
    min-inline-size: 0;
  }

  &__workspace {
    font-weight: var(--nb-type-label-lg-weight, 600);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__product {
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  &__menu {
    position: absolute;
    inset-block-start: 100%;
    inset-inline-start: 0;
    z-index: var(--nb-zindex-dropdown, 30);
    min-inline-size: 12rem;
  }
}
</style>
