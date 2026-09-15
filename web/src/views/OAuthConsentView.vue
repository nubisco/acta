<template>
  <div class="consent">
    <NbPanel class="consent__panel">
      <img
        class="consent__mark"
        src="/acta-icon.svg"
        alt="Acta"
        width="44"
        height="44"
      />

      <template v-if="state === 'loading'">
        <p class="consent__note">
          <NbSpinner size="sm" /> Checking this request...
        </p>
      </template>

      <template v-else-if="state === 'invalid'">
        <h1 class="type-heading-03">Cannot continue</h1>
        <NbBanner status="error" variant="inline" :title="reason" />
        <p class="consent__note">
          Nothing has been shared. Go back to the app and connect again.
        </p>
      </template>

      <template v-else-if="state === 'signed-out'">
        <h1 class="type-heading-03">Sign in to continue</h1>
        <p class="consent__note">
          <strong>{{ clientName }}</strong> is asking to connect to Acta. Sign
          in and you will come straight back here.
        </p>
        <NbButton variant="primary" @click="signIn">Sign in</NbButton>
      </template>

      <template v-else>
        <h1 class="type-heading-03">Connect {{ clientName }}?</h1>
        <p class="consent__note">
          <strong>{{ clientName }}</strong> will act in this workspace as
          <strong>@{{ handle }}</strong
          >, with your role, and anything it does will be recorded under your
          name. It can read and change spaces, cards and documents, but not
          administer the workspace. You can cut it off any time in Settings,
          under Access tokens.
        </p>
        <div class="consent__row">
          <NbButton variant="ghost" @click="decide('deny')"> Cancel </NbButton>
          <NbButton variant="primary" @click="decide('approve')">
            Connect
          </NbButton>
        </div>
      </template>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'

/**
 * The OAuth consent screen, reached by redirect from GET /oauth/authorize.
 *
 * A page of the app rather than worker-templated HTML, so it is built from
 * the design system like every other surface and stays that way as the system
 * moves. The server still owns the truth: /oauth/context validates the
 * request, and the decision is a REAL form post to POST /oauth/authorize,
 * because approval answers with a redirect back to the connecting app that
 * the browser itself has to follow.
 */
const route = useRoute()

const PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const

const state = ref<'loading' | 'invalid' | 'signed-out' | 'consent'>('loading')
const clientName = ref('This app')
const handle = ref('')
const reason = ref('That request cannot be approved')

function params(): URLSearchParams {
  const qs = new URLSearchParams()
  for (const k of PARAMS) {
    const v = route.query[k]
    if (typeof v === 'string' && v) qs.set(k, v)
  }
  return qs
}

async function load(): Promise<void> {
  try {
    const res = await fetch(`/oauth/context?${params().toString()}`, {
      credentials: 'include',
    })
    const ctx = (await res.json()) as {
      ok: boolean
      reason?: string
      clientName?: string
      handle?: string | null
    }
    if (!ctx.ok) {
      reason.value = ctx.reason ?? reason.value
      state.value = 'invalid'
      return
    }
    clientName.value = ctx.clientName ?? 'This app'
    handle.value = ctx.handle ?? ''
    state.value = ctx.handle ? 'consent' : 'signed-out'
  } catch {
    state.value = 'invalid'
  }
}
void load()

/**
 * Back here afterwards, parameters intact. Landing at the workspace home
 * instead would throw the connector's request away silently.
 */
function signIn(): void {
  const back = `/oauth/consent?${params().toString()}`
  window.location.href = `/login?to=${encodeURIComponent(back)}`
}

/** Only a real form post lets the browser follow the redirect to the app. */
function decide(decision: 'approve' | 'deny'): void {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = '/oauth/authorize'
  const add = (name: string, value: string): void => {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  for (const [k, v] of params()) add(k, v)
  add('decision', decision)
  document.body.appendChild(form)
  form.submit()
}
</script>

<style scoped lang="scss">
/* The sign-in card's shape, on purpose: this is Acta's other front door. */
.consent {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  background: var(--nb-c-bg);

  &__panel {
    width: min(90vw, 26rem);
    display: grid;
    gap: var(--nb-spacing-16);
    text-align: center;

    h1 {
      margin: 0;
    }
  }

  &__mark {
    display: block;
    width: 44px;
    height: 44px;
    margin-inline: auto;
  }

  &__note {
    margin: 0;
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
    line-height: 1.55;
  }

  &__row {
    display: flex;
    gap: var(--nb-spacing-8);
    justify-content: center;
  }
}
</style>
