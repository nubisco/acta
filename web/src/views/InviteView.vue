<template>
  <div class="invite">
    <NbPanel class="invite__panel">
      <img
        class="invite__mark"
        src="/acta-icon.svg"
        alt="Acta"
        width="44"
        height="44"
      />

      <p v-if="state === 'loading'" class="invite__note">
        <NbSpinner size="sm" /> Checking this invitation...
      </p>

      <template v-else-if="state === 'invalid'">
        <h1 class="type-heading-03">This invitation cannot be used</h1>
        <NbBanner status="error" variant="inline" :title="reason" />
        <p class="invite__note">Ask whoever invited you to send a new one.</p>
      </template>

      <template v-else-if="invite">
        <h1 class="type-heading-03">Join {{ invite.workspace }}</h1>
        <p class="invite__note">
          <strong>{{ invite.inviter }}</strong> invited
          <strong>{{ invite.email }}</strong> to {{ invite.workspace }} as
          {{ invite.role === 'admin' ? 'an admin' : 'a member' }}.
          <template v-if="invite.proof === 'provider'">
            You will be asked to sign in as that address.
          </template>
        </p>
        <NbBanner v-if="error" status="error" variant="inline" :title="error" />
        <NbButton variant="primary" :loading="accepting" @click="accept">
          Accept and join
        </NbButton>
      </template>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
/**
 * Accepting an invitation (LA-397).
 *
 * The link in the email opens this page and nothing else: accepting is the
 * button, a POST, because mail scanners fetch every link in a message and an
 * invitation that accepted itself when one looked would prove nothing.
 *
 * Behind a provider, accepting sends the person through it, and the server
 * checks that the address they sign in as is the one invited. Without one,
 * the link was only ever sent to that address, which is the proof, and the
 * server signs them straight in.
 */
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { api, ApiHttpError } from '@/api/client'

const route = useRoute()
const token = String(route.params.token ?? '')

type TPreview = Awaited<ReturnType<typeof api.invitationPreview>>

const state = ref<'loading' | 'invalid' | 'ready'>('loading')
const invite = ref<TPreview | null>(null)
const reason = ref('This invitation does not exist')
const error = ref('')
const accepting = ref(false)

const STATUS_WORDS: Record<string, string> = {
  expired: 'This invitation has expired',
  revoked: 'This invitation was withdrawn',
  accepted: 'This invitation was already accepted. Sign in instead.',
}

async function load(): Promise<void> {
  try {
    const preview = await api.invitationPreview(token)
    // Accepted is only a dead end without a provider. Behind one, accepting
    // again is just signing in as the person it was for.
    if (
      preview.status !== 'pending' &&
      !(preview.status === 'accepted' && preview.proof === 'provider')
    ) {
      reason.value = STATUS_WORDS[preview.status] ?? reason.value
      state.value = 'invalid'
      return
    }
    invite.value = preview
    state.value = 'ready'
  } catch {
    state.value = 'invalid'
  }
}
void load()

async function accept(): Promise<void> {
  accepting.value = true
  error.value = ''
  try {
    const { next } = await api.acceptInvitation(token)
    window.location.href = next
  } catch (err) {
    error.value =
      err instanceof ApiHttpError && err.status === 429
        ? 'Too many attempts. Wait a minute and try again.'
        : err instanceof ApiHttpError
          ? err.message
          : 'Could not reach the server'
    accepting.value = false
  }
}
</script>

<style scoped lang="scss">
/* The sign-in card's shape, like the consent screen: another front door. */
.invite {
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
}
</style>
