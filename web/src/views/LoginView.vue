<template>
  <div class="login">
    <NbPanel class="login__panel">
      <NbNubiscoMark class="login__mark" />
      <h1>Acta</h1>

      <NbBanner
        v-if="ssoError"
        status="error"
        variant="inline"
        :title="ssoError"
      />

      <template v-if="ssoAvailable && stage === 'email'">
        <NbButton variant="primary" @click="startSso">
          Continue with single sign-on
        </NbButton>
        <p class="login__divider">or use a one-time code</p>
      </template>

      <NbForm
        v-if="stage === 'email'"
        id="login-email-form"
        aria-label="Request a sign-in code"
        @submit.prevent="requestCode"
      >
        <NbBanner
          v-if="formError"
          status="error"
          variant="inline"
          :title="formError"
        />
        <NbTextInput
          id="field-email"
          ref="emailInput"
          v-model="email"
          type="email"
          label="Workspace email"
          placeholder="you@nubisco.io"
          :error="errors.email"
          @blur="validateEmail"
        />
        <template #footer>
          <NbButton type="submit" variant="primary" :loading="busy">
            Send code
          </NbButton>
        </template>
      </NbForm>

      <NbForm
        v-else
        id="login-code-form"
        aria-label="Enter your sign-in code"
        @submit.prevent="verify"
      >
        <NbBanner
          v-if="formError"
          status="error"
          variant="inline"
          :title="formError"
        />
        <NbTextInput
          id="field-code"
          ref="codeInput"
          v-model="code"
          inputmode="numeric"
          label="Six-digit code"
          :placeholder="`Sent to ${email}`"
          :maxlength="6"
          :error="errors.code"
          @blur="validateCode"
        />
        <template #footer>
          <NbButton type="button" variant="secondary" @click="backToEmail">
            Use a different email
          </NbButton>
          <NbButton type="submit" variant="primary" :loading="busy">
            Sign in
          </NbButton>
        </template>
      </NbForm>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NbBanner,
  NbButton,
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
const ssoError = ref('')
const formError = ref('')
const errors = reactive<{ email?: string; code?: string }>({})
const emailInput = ref<InstanceType<typeof NbTextInput> | null>(null)
const codeInput = ref<InstanceType<typeof NbTextInput> | null>(null)
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
    ssoError.value = messages[error] ?? 'Sign-in failed'
  }
})

function startSso(): void {
  window.location.href = '/api/v1/auth/sso/start'
}

function validateEmail(): void {
  errors.email = /.+@.+\..+/.test(email.value)
    ? undefined
    : 'Enter your workspace email address'
}

function validateCode(): void {
  errors.code = /^\d{6}$/.test(code.value)
    ? undefined
    : 'The code is six digits'
}

function backToEmail(): void {
  stage.value = 'email'
  code.value = ''
  formError.value = ''
  requestAnimationFrame(() => emailInput.value?.focus())
}

async function requestCode(): Promise<void> {
  validateEmail()
  if (errors.email) return
  busy.value = true
  formError.value = ''
  try {
    await auth.requestOtp(email.value)
    stage.value = 'code'
    toast.info('If that address is a member, a code is on its way', {
      retain: true,
    })
    requestAnimationFrame(() => codeInput.value?.focus())
  } catch {
    formError.value = 'Could not request a code; try again'
  } finally {
    busy.value = false
  }
}

async function verify(): Promise<void> {
  validateCode()
  if (errors.code) return
  busy.value = true
  formError.value = ''
  try {
    await auth.verifyOtp(email.value, code.value)
    await ws.loadMe()
    await ws.refresh()
    ws.connect()
    void router.push(String(route.query.to ?? '/'))
  } catch {
    formError.value = 'That code is invalid or expired'
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
  background: var(--nb-c-bg);

  &__panel {
    width: min(90vw, 24rem);
    display: grid;
    gap: var(--nb-spacing-16);
    text-align: center;

    h1 {
      margin: 0;
    }
  }

  &__mark {
    width: 48px;
    margin-inline: auto;
  }

  &__divider {
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
    margin: 0;
  }
}
</style>
