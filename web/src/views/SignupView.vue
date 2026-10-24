<template>
  <div class="signup">
    <NbPanel class="signup__panel">
      <img
        class="signup__mark"
        src="/acta-icon.svg"
        alt="Acta"
        width="44"
        height="44"
      />

      <p v-if="phase === 'loading'" class="signup__note">
        <NbSpinner size="sm" /> One moment...
      </p>

      <template v-else-if="phase === 'unavailable'">
        <h1 class="type-heading-03">Workspaces are created by an admin here</h1>
        <p class="signup__note">
          This instance does not offer signup. Ask whoever runs it for an
          invitation.
        </p>
        <NbButton variant="secondary" @click="goToSignIn">Sign in</NbButton>
      </template>

      <template v-else-if="phase === 'signed-out'">
        <h1 class="type-heading-03">Create your workspace</h1>
        <p class="signup__note">
          Sign in first. Your workspace is created for the address you sign in
          with.
        </p>
        <NbButton variant="primary" @click="goToSignIn">Sign in</NbButton>
      </template>

      <template v-else-if="phase === 'cap'">
        <h1 class="type-heading-03">You already have a workspace</h1>
        <p class="signup__note">
          An account can create {{ state?.cap ?? 1 }} workspace on the hosted
          service. For more, talk to us.
        </p>
        <div class="signup__actions">
          <NbButton variant="secondary" @click="router.push('/')">
            Your workspaces
          </NbButton>
          <NbButton
            v-if="state?.sales_url"
            variant="primary"
            :href="state.sales_url"
            target="_blank"
            rel="noopener"
          >
            Contact sales
          </NbButton>
        </div>
      </template>

      <template v-else>
        <NbStepper
          v-model="step"
          size="sm"
          :orientation="phone ? 'vertical' : 'horizontal'"
          aria-label="Setting up your workspace"
          class="signup__stepper"
        >
          <NbStepperStep label="Workspace" />
          <NbStepperStep label="First space" description="Optional" />
          <NbStepperStep label="Invite" description="Optional" />
          <NbStepperStep label="First card" description="Optional" />
        </NbStepper>

        <NbBanner
          v-if="error"
          status="error"
          variant="inline"
          :title="error"
          class="signup__banner"
        />

        <!-- 1. The workspace itself. -->
        <NbForm
          v-if="step === 0"
          id="signup-workspace"
          @submit.prevent="create"
        >
          <h1 class="type-heading-03">Create your workspace</h1>
          <p class="signup__note">
            Signed in as <strong>{{ state?.identity?.email }}</strong
            >. You will be its admin.
          </p>
          <NbTextInput
            id="signup-name"
            v-model="name"
            label="Workspace name"
            placeholder="Acme"
            :error="errors.name"
            @update:model-value="suggestSlug"
          />
          <NbTextInput
            id="signup-slug"
            v-model="slug"
            label="Address"
            :helper="`${host}/${slug || 'your-workspace'}`"
            :error="errors.slug"
            @update:model-value="slugTouched = true"
            @blur="checkSlug"
          />
          <template v-if="state?.terms">
            <p class="signup__note">
              Read the
              <a
                v-if="state.terms.terms_url"
                :href="state.terms.terms_url"
                target="_blank"
                rel="noopener"
                >terms of service</a
              ><template v-else>terms of service</template>
              and the
              <a
                v-if="state.terms.privacy_url"
                :href="state.terms.privacy_url"
                target="_blank"
                rel="noopener"
                >privacy notice</a
              ><template v-else>privacy notice</template>.
            </p>
            <NbCheckbox
              id="signup-terms"
              v-model="acceptsTerms"
              label="I accept the terms of service and the privacy notice"
            />
          </template>
          <div class="signup__actions">
            <NbButton
              type="submit"
              variant="primary"
              :loading="busy"
              :disabled="Boolean(state?.terms) && !acceptsTerms"
            >
              Create workspace
            </NbButton>
          </div>
        </NbForm>

        <!-- 2. A first space, from a template. -->
        <NbForm
          v-else-if="step === 1"
          id="signup-space"
          @submit.prevent="createSpace"
        >
          <h1 class="type-heading-03">Start a space</h1>
          <p class="signup__note">
            A space holds one team's or one project's cards. You can add more
            later.
          </p>
          <NbRadio
            v-model="template"
            name="signup-template"
            label="Start from"
            :options="TEMPLATE_OPTIONS"
          />
          <NbTextInput
            id="signup-space-name"
            v-model="spaceName"
            label="Space name"
            placeholder="Product"
            :error="errors.spaceName"
            @update:model-value="suggestKey"
          />
          <NbTextInput
            id="signup-space-key"
            v-model="spaceKey"
            label="Key"
            helper="Cards in it are numbered with this, like PR-1."
            :error="errors.spaceKey"
            @update:model-value="keyTouched = true"
          />
          <div class="signup__actions">
            <NbButton type="button" variant="ghost" @click="step = 2">
              Skip
            </NbButton>
            <NbButton type="submit" variant="primary" :loading="busy">
              Create space
            </NbButton>
          </div>
        </NbForm>

        <!-- 3. Invitations. Nobody joins until they accept. -->
        <NbForm
          v-else-if="step === 2"
          id="signup-invite"
          @submit.prevent="invite"
        >
          <h1 class="type-heading-03">Invite your team</h1>
          <p class="signup__note">
            Each person gets an email and joins when they accept it.
          </p>
          <div
            v-for="(row, index) in invites"
            :key="index"
            class="signup__invite"
          >
            <NbTextInput
              :id="`signup-invite-email-${index}`"
              v-model="row.email"
              type="email"
              label="Email"
              placeholder="colleague@example.com"
            />
            <NbTextInput
              :id="`signup-invite-name-${index}`"
              v-model="row.name"
              label="Name"
              placeholder="Optional"
            />
          </div>
          <NbButton
            v-if="invites.length < MAX_INVITES"
            type="button"
            variant="ghost"
            icon="plus"
            @click="invites.push({ email: '', name: '' })"
          >
            Add another
          </NbButton>
          <div class="signup__actions">
            <NbButton type="button" variant="ghost" @click="afterInvites">
              Skip
            </NbButton>
            <NbButton type="submit" variant="primary" :loading="busy">
              Send invitations
            </NbButton>
          </div>
        </NbForm>

        <!-- 4. A first card in the space. -->
        <NbForm v-else id="signup-card" @submit.prevent="createCard">
          <h1 class="type-heading-03">Add a first card</h1>
          <p class="signup__note">
            Something your team is working on. It goes in {{ createdSpace }},
            under To Do.
          </p>
          <NbTextInput
            id="signup-card-title"
            v-model="cardTitle"
            label="Title"
            placeholder="Plan the launch"
            :error="errors.cardTitle"
          />
          <div class="signup__actions">
            <NbButton type="button" variant="ghost" @click="finish">
              Skip
            </NbButton>
            <NbButton type="submit" variant="primary" :loading="busy">
              Add card
            </NbButton>
          </div>
        </NbForm>
      </template>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
/**
 * Signup and onboarding (LA-398): create a workspace, then optionally a first
 * space, invitations and a first card.
 *
 * Two kinds of person arrive. Someone the identity provider just vouched for,
 * who belongs to no workspace, is sent here by the sign-in callback with a
 * signup cookie. Someone already signed in comes from "Create a workspace" on
 * the workspaces page. The server knows which (signupState), so this page
 * never asks for an email: the workspace is created for the address already
 * proved.
 *
 * Only the first step is required. Each later one can be skipped, and each
 * uses the ordinary workspace API, so what it creates is exactly what the
 * same action creates anywhere else in the app.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { usePhoneLayout } from '@nubisco/ui'
import {
  api,
  auth,
  newOpId,
  setWorkspaceSlug,
  type ISignupState,
} from '@/api/client'
import { trackEvent } from '@/composables/useAnalytics'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

const router = useRouter()
const ws = useWorkspace()
const { phone } = usePhoneLayout()

const MAX_INVITES = 5
const TEMPLATE_OPTIONS = [
  {
    value: 'kanban6',
    label: 'Board: Backlog, To Do, In Progress, Blocked, Review, Done',
  },
  { value: 'none', label: 'Empty: add your own lists' },
]

type TPhase = 'loading' | 'unavailable' | 'signed-out' | 'cap' | 'wizard'

const phase = ref<TPhase>('loading')
const state = ref<ISignupState | null>(null)
const step = ref(0)
const busy = ref(false)
const error = ref('')
const errors = reactive<{
  name?: string
  slug?: string
  spaceName?: string
  spaceKey?: string
  cardTitle?: string
}>({})
const host = computed(() => location.host)

// Step 1
const name = ref('')
const slug = ref('')
const slugTouched = ref(false)
const acceptsTerms = ref(false)
const createdSlug = ref('')

// Step 2
const template = ref<'kanban6' | 'none'>('kanban6')
const spaceName = ref('')
const spaceKey = ref('')
const keyTouched = ref(false)
const createdSpace = ref('')

// Step 3
const invites = ref([{ email: '', name: '' }])

// Step 4
const cardTitle = ref('')

function goToSignIn(): void {
  location.href = auth.signInUrl('/signup')
}

let slugTimer: ReturnType<typeof setTimeout> | null = null

/** The address follows the name until the person edits it themselves. */
function suggestSlug(): void {
  errors.name = undefined
  if (slugTouched.value) return
  if (slugTimer) clearTimeout(slugTimer)
  slugTimer = setTimeout(async () => {
    if (!name.value.trim()) {
      slug.value = ''
      return
    }
    try {
      const suggestion = await auth.signupSlug({ name: name.value })
      if (!slugTouched.value) slug.value = suggestion.slug
    } catch {
      // The server picks one on create anyway.
    }
  }, 250)
}

async function checkSlug(): Promise<void> {
  slug.value = slug.value.trim().toLowerCase()
  errors.slug = undefined
  if (!slug.value) return
  try {
    const answer = await auth.signupSlug({ slug: slug.value })
    if (!answer.available) errors.slug = answer.problem ?? 'Not available'
  } catch (err) {
    errors.slug = humanise(err)
  }
}

async function create(): Promise<void> {
  errors.name = name.value.trim() ? undefined : 'Give the workspace a name'
  if (errors.name || errors.slug) return
  busy.value = true
  error.value = ''
  try {
    const created = await auth.createWorkspace({
      name: name.value.trim(),
      slug: slug.value || undefined,
      terms_version: acceptsTerms.value
        ? state.value?.terms?.version
        : undefined,
    })
    trackEvent('Workspace Created')
    if (state.value?.identity?.source === 'pending')
      trackEvent('Signup Completed')
    createdSlug.value = created.slug
    ws.forgetWorkspaces()
    setWorkspaceSlug(created.slug)
    await ws.loadMe()
    await ws.enterWorkspace(created.slug)
    step.value = 1
  } catch (err) {
    error.value = humanise(err)
  } finally {
    busy.value = false
  }
}

/** Initials of the name, the way the new-space dialog does it. */
function suggestKey(): void {
  errors.spaceName = undefined
  if (keyTouched.value) return
  spaceKey.value = spaceName.value
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 5)
  if (spaceKey.value.length === 1)
    spaceKey.value = spaceName.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 3)
}

async function createSpace(): Promise<void> {
  spaceKey.value = spaceKey.value.toUpperCase().trim()
  errors.spaceName = spaceName.value.trim() ? undefined : 'Name the space'
  errors.spaceKey = /^[A-Z][A-Z0-9]{1,4}$/.test(spaceKey.value)
    ? undefined
    : 'Use 2 to 5 uppercase letters or digits'
  if (errors.spaceName || errors.spaceKey) return
  busy.value = true
  error.value = ''
  try {
    const { results } = await api.spaceWrite([
      {
        op: 'create',
        op_id: newOpId(),
        key: spaceKey.value,
        name: spaceName.value.trim(),
        template: template.value,
      },
    ])
    if (!results[0].ok) {
      errors.spaceKey = 'That key is already taken'
      return
    }
    // Only a board has a To Do list for the first card to go in.
    if (template.value === 'kanban6') createdSpace.value = spaceKey.value
    trackEvent('First Space', { template: template.value })
    step.value = 2
  } catch (err) {
    error.value = humanise(err)
  } finally {
    busy.value = false
  }
}

async function invite(): Promise<void> {
  const rows = invites.value.filter((r) => r.email.trim())
  if (rows.length === 0) {
    afterInvites()
    return
  }
  busy.value = true
  error.value = ''
  const failed: string[] = []
  let sent = 0
  for (const row of rows) {
    const email = row.email.trim()
    try {
      await api.inviteMember({
        email,
        name: row.name.trim() || email.split('@')[0],
        role: 'member',
      })
      sent++
    } catch (err) {
      failed.push(`${email}: ${humanise(err)}`)
    }
  }
  busy.value = false
  if (sent > 0) trackEvent('First Invite', { count: sent })
  if (failed.length > 0) {
    error.value = failed.join('. ')
    invites.value = invites.value.filter((r) =>
      failed.some((f) => f.startsWith(`${r.email.trim()}:`)),
    )
    return
  }
  afterInvites()
}

function afterInvites(): void {
  if (createdSpace.value) step.value = 3
  else finish()
}

async function createCard(): Promise<void> {
  errors.cardTitle = cardTitle.value.trim() ? undefined : 'Give it a title'
  if (errors.cardTitle) return
  busy.value = true
  error.value = ''
  try {
    await api.itemWrite(
      [
        {
          op: 'create',
          op_id: newOpId(),
          list: 'To Do',
          title: cardTitle.value.trim(),
        },
      ],
      createdSpace.value,
    )
    finish()
  } catch (err) {
    error.value = humanise(err)
  } finally {
    busy.value = false
  }
}

function finish(): void {
  const base = `/${createdSlug.value}`
  void router.push(
    createdSpace.value ? `${base}/s/${createdSpace.value}` : base,
  )
}

onMounted(async () => {
  await ws.loadAuthConfig()
  if (!ws.signupEnabled.value) {
    phase.value = 'unavailable'
    return
  }
  try {
    state.value = await auth.signupState()
  } catch (err) {
    error.value = humanise(err)
    phase.value = 'signed-out'
    return
  }
  if (!state.value.identity) {
    phase.value = 'signed-out'
    return
  }
  if (!state.value.can_create) {
    phase.value = 'cap'
    return
  }
  if (state.value.identity.source === 'pending') trackEvent('Signup Started')
  phase.value = 'wizard'
})
</script>

<style scoped lang="scss">
.signup {
  display: grid;
  place-items: center;
  min-block-size: 100vh;
  padding: var(--nb-spacing-24);

  &__panel {
    display: grid;
    gap: var(--nb-spacing-16);
    inline-size: min(36rem, 100%);
    padding: var(--nb-spacing-32);
  }

  &__mark {
    display: block;
  }

  h1 {
    margin: 0;
  }

  &__note {
    margin: 0;
    color: var(--nb-c-text-subtle);
  }

  &__stepper,
  &__banner {
    inline-size: 100%;
  }

  form {
    display: grid;
    gap: var(--nb-spacing-16);
  }

  &__invite {
    display: grid;
    grid-template-columns: 3fr 2fr;
    gap: var(--nb-spacing-8);
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--nb-spacing-8);
  }
}

// A phone: the panel fills the width, the invitation rows stack, and the
// buttons span the screen so a thumb finds them.
@include variables.phone {
  .signup {
    place-items: start stretch;
    padding: var(--nb-spacing-16);

    &__panel {
      inline-size: 100%;
      padding: var(--nb-spacing-16);
    }

    &__invite {
      grid-template-columns: 1fr;
    }

    &__actions {
      flex-direction: column-reverse;

      > * {
        inline-size: 100%;
      }
    }
  }
}
</style>
