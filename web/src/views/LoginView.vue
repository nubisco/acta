<template>
  <div class="login">
    <NbPanel class="login__panel">
      <NbNubiscoMark class="login__mark" />
      <h1>Acta</h1>
      <p v-if="stage === 'email'">Sign in with your workspace email.</p>
      <p v-else>Enter the six-digit code sent to {{ email }}.</p>

      <template v-if="ssoAvailable && stage === 'email'">
        <NbButton variant="primary" @click="startSso">
          Continue with single sign-on
        </NbButton>
        <p class="login__divider">or use a one-time code</p>
      </template>

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
import { onMounted, ref } from 'vue'
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
const ssoAvailable = ref(false)
const toast = useToast()
const router = useRouter()
const route = useRoute()
const ws = useWorkspace()

onMounted(async () => {
  try {
    const res = await fetch('/api/v1/auth/config')
    ssoAvailable.value = ((await res.json()) as { sso: boolean }).sso
  } catch {
    ssoAvailable.value = false
  }
  const error = route.query.error
  if (typeof error === 'string') {
    const messages: Record<string, string> = {
      not_a_member: 'Your account is not a member of this workspace',
      disabled: 'This account is disabled',
      sso_state: 'The sign-in attempt expired; try again',
      sso_token: 'Single sign-on failed; try again',
    }
    toast.error(messages[error] ?? 'Sign-in failed', { retain: true })
  }
})

function startSso(): void {
  window.location.href = '/api/v1/auth/sso/start'
}

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

  &__divider {
    font-size: 0.85rem;
    opacity: 0.6;
    margin: 0;
  }
}
</style>
