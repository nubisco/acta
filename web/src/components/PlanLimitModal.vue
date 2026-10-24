<template>
  <NbModal
    close-appearance="button"
    :open="limit !== null"
    title="This workspace's plan is full"
    size="sm"
    @close="limit = null"
  >
    <p class="plan-limit__body">{{ limit?.message }}</p>
    <p v-if="!ws.isAdmin.value" class="plan-limit__body">
      An admin of this workspace can upgrade it from Settings.
    </p>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="limit = null">
        Close
      </NbButton>
      <NbButton
        v-if="ws.isAdmin.value"
        type="button"
        variant="primary"
        @click="seePlans"
      >
        See plans
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * The upgrade prompt (LA-399). Any request the plan refuses, from any create
 * flow, opens it: the API client hears the plan_limit and this shows it once,
 * in the same words the server used, with the way to lift it for admins.
 * Nothing opens on an instance without plans, because nothing is refused.
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { onPlanLimit, type IPlanLimit } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'
import { wpath } from '@/lib/paths'

const ws = useWorkspace()
const router = useRouter()
const limit = ref<IPlanLimit | null>(null)

let stop: (() => void) | null = null
onMounted(() => {
  stop = onPlanLimit((l) => {
    if (ws.plansEnabled.value) limit.value = l
  })
})
onUnmounted(() => stop?.())

function seePlans(): void {
  limit.value = null
  void router.push(wpath('/settings?tab=billing'))
}
</script>

<style scoped lang="scss">
.plan-limit__body {
  margin: 0 0 var(--nb-spacing-12);
}
</style>
