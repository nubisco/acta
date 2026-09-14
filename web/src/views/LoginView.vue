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

      <!-- Already on the way out to the provider. Shown rather than a blank
           panel, because a page that flashes a form and then navigates away
           reads as a glitch. -->
      <p v-if="handingOver" class="login__handover">
        <NbSpinner size="sm" /> Taking you to {{ ssoLabel }}...
      </p>

      <template v-if="!handingOver && ssoAvailable && stage === 'email'">
        <NbButton variant="primary" @click="startSso">
          Sign in with {{ ssoLabel }}
        </NbButton>
        <p v-if="otpAvailable" class="login__divider">or use a one-time code</p>
      </template>

      <NbForm
        v-if="otpAvailable && !handingOver && stage === 'email'"
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
        v-else-if="otpAvailable && !handingOver"
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
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToast } from '@nubisco/ui'
import type { NbTextInput } from '@nubisco/ui'
import { auth } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'

const email = ref('')
const code = ref('')
const stage = ref<'email' | 'code'>('email')
const busy = ref(false)
const ssoAvailable = ref(false)
/**
 * What to call the provider.
 *
 * This said "Nubisco Platform" in the markup, which is correct on exactly one
 * instance. Every self-hosted deployment was telling its users to sign in
 * with a product they have no account on; the server now reports the name and
 * an operator sets it with ACTA_OIDC_LABEL.
 */
const ssoLabel = ref('single sign-on')
const otpAvailable = ref(true)
const ssoError = ref('')
const formError = ref('')
const errors = reactive<{ email?: string; code?: string }>({})
const emailInput = ref<InstanceType<typeof NbTextInput> | null>(null)
const codeInput = ref<InstanceType<typeof NbTextInput> | null>(null)
const toast = useToast()
const router = useRouter()
const route = useRoute()
const ws = useWorkspace()

/**
 * Where the provider is the identity, this page is a doorway rather than a
 * form: it hands straight over to it.
 *
 * Two things stop that becoming a trap. A failed sign-in comes back with
 * ?error=, and bouncing straight out again would be an infinite round trip
 * between here and the provider, so an error shows the page instead. And
 * ?code=1 asks for the one-time-code form deliberately, which is the way back
 * in when the provider itself is down: that happened, and the only reason it
 * was recoverable was that this form existed.
 *
 * An instance with no provider configured never redirects at all, because
 * codes are the only way in. That is the self-hosted case, and it is why the
 * form stays rather than being deleted.
 */
const wantsCode = computed(() => route.query.code !== undefined)
const failed = computed(() => typeof route.query.error === 'string')
const handingOver = ref(false)

onMounted(async () => {
  try {
    const res = await fetch('/api/v1/auth/config')
    const cfg = (await res.json()) as {
      sso: boolean
      otp: boolean
      sso_label?: string
    }
    ssoAvailable.value = cfg.sso
    otpAvailable.value = cfg.otp
    if (cfg.sso_label) ssoLabel.value = cfg.sso_label
  } catch {
    ssoAvailable.value = false
    otpAvailable.value = true
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
  // With codes off there is nothing else here, so even a failure hands back
  // to the provider on the next attempt rather than showing a dead form.
  if (
    ssoAvailable.value &&
    !failed.value &&
    !(wantsCode.value && otpAvailable.value)
  ) {
    handingOver.value = true
    startSso()
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

  &__handover {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--nb-spacing-8);
    margin: 0;
    padding-block: var(--nb-spacing-16);
    color: var(--nb-c-text-subtle);
  }
}
</style>
