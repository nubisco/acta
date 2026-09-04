<template>
  <div class="login">
    <NbPanel class="login__panel">
      <NbNubiscoMark class="login__mark" />
      <h1>Acta</h1>
      <p v-if="stage === 'email'">Sign in with your workspace email.</p>
      <p v-else>Enter the six-digit code sent to {{ email }}.</p>

      <NbForm v-if="stage === 'email'" @submit.prevent="requestCode">
        <NbField label="Email">
          <NbTextInput
            v-model="email"
            type="email"
            placeholder="you@nubisco.io"
            autofocus
          />
        </NbField>
        <NbButton type="submit" variant="primary" :disabled="!email || busy"
          >Send code</NbButton
        >
      </NbForm>

      <NbForm v-else @submit.prevent="verify">
        <NbField label="Code">
          <NbTextInput
            v-model="code"
            inputmode="numeric"
            placeholder="123456"
            autofocus
          />
        </NbField>
        <NbButton
          type="submit"
          variant="primary"
          :disabled="code.length !== 6 || busy"
          >Sign in</NbButton
        >
        <NbButton variant="ghost" @click="stage = 'email'">Back</NbButton>
      </NbForm>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NbButton,
  NbField,
  NbForm,
  NbNubiscoMark,
  NbPanel,
  NbTextInput,
  useToast,
} from '@nubisco/ui'
import { auth } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'

const email = ref('')
const code = ref('')
const stage = ref<'email' | 'code'>('email')
const busy = ref(false)
const toast = useToast()
const router = useRouter()
const route = useRoute()
const ws = useWorkspace()

async function requestCode(): Promise<void> {
  busy.value = true
  try {
    await auth.requestOtp(email.value)
    stage.value = 'code'
    toast.info('If that address is a member, a code is on its way')
  } catch {
    toast.error('Could not request a code')
  } finally {
    busy.value = false
  }
}

async function verify(): Promise<void> {
  busy.value = true
  try {
    await auth.verifyOtp(email.value, code.value)
    await ws.loadMe()
    await ws.refresh()
    ws.connect()
    void router.push(String(route.query.to ?? '/'))
  } catch {
    toast.error('Invalid or expired code')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped lang="scss">
.login {
  min-height: 100dvh;
  display: grid;
  place-items: center;

  &__panel {
    width: min(90vw, 24rem);
    display: grid;
    gap: calc(var(--nb-base-unit) * 2);
    text-align: center;
  }

  &__mark {
    width: 48px;
    margin-inline: auto;
  }
}
</style>
