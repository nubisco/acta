<template>
  <NbModal
    close-appearance="button"
    :open="open"
    :title="link ? 'Invitation ready' : 'Invite member'"
    size="sm"
    :close-on-overlay="!isDirty"
    @close="emit('close')"
  >
    <div v-if="link" class="invite-link">
      <p class="invite-link__note">
        This instance does not send email, so pass this link to
        {{ invitedName }} yourself. It works once, for {{ invitedEmail }}, and
        expires in 7 days.
      </p>
      <NbTextInput
        id="field-invite-link"
        :model-value="link"
        label="Invitation link"
        readonly
      />
    </div>
    <NbForm v-else id="new-member-form" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />
      <NbTextInput
        id="field-member-email"
        ref="emailInput"
        v-model="email"
        type="email"
        label="Email"
        placeholder="name@example.com"
        :error="errors.email"
        @blur="validateEmail"
      />
      <NbTextInput
        id="field-member-name"
        v-model="name"
        label="Name"
        placeholder="Their full name"
        :error="errors.name"
        @blur="validateName"
      />
      <NbSelect
        id="field-member-role"
        v-model="role"
        label="Role"
        :options="roleOptions"
      />
    </NbForm>
    <template #footer>
      <template v-if="link">
        <NbButton type="button" variant="secondary" @click="copyLink">
          Copy link
        </NbButton>
        <NbButton type="button" variant="primary" @click="emit('close')">
          Done
        </NbButton>
      </template>
      <template v-else>
        <NbButton type="button" variant="secondary" @click="emit('close')">
          Cancel
        </NbButton>
        <NbButton
          type="submit"
          form="new-member-form"
          variant="primary"
          :loading="saving"
        >
          Send invitation
        </NbButton>
      </template>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * Invite someone (LA-397). Nobody becomes a member by an admin typing an
 * address: the person accepts, which proves the address is theirs, and only
 * then exists in the workspace. On an instance that sends email the link goes
 * to them and never to the admin. On one that does not, the admin is the
 * delivery, so the link is shown here to pass on.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useToast, type NbTextInput } from '@nubisco/ui'
import { api, ApiHttpError } from '@/api/client'
import { humanise } from '@/lib/state'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; created: [emailed: boolean] }>()

const toast = useToast()
const link = ref('')
const invitedName = ref('')
const invitedEmail = ref('')
const email = ref('')
const name = ref('')
const role = ref<'admin' | 'member'>('member')
const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ email?: string; name?: string }>({})
const emailInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const isDirty = computed(() => email.value !== '' || name.value !== '')

const roleOptions = [
  { label: 'Member', value: 'member' },
  { label: 'Admin', value: 'admin' },
]

watch(
  () => props.open,
  (open) => {
    if (open) {
      link.value = ''
      email.value = ''
      name.value = ''
      role.value = 'member'
      serverError.value = ''
      errors.email = undefined
      errors.name = undefined
      requestAnimationFrame(() => emailInput.value?.focus())
    }
  },
)

function validateEmail(): void {
  errors.email = /.+@.+\..+/.test(email.value)
    ? undefined
    : 'Enter their email address'
}

function validateName(): void {
  errors.name = name.value.trim() ? undefined : 'Enter their name'
}

async function submit(): Promise<void> {
  validateEmail()
  validateName()
  if (errors.email || errors.name) return
  saving.value = true
  serverError.value = ''
  try {
    const out = await api.inviteMember({
      email: email.value.trim(),
      name: name.value.trim(),
      role: role.value,
    })
    emit('created', out.emailed)
    if (out.accept_url) {
      invitedName.value = name.value.trim()
      invitedEmail.value = email.value.trim()
      link.value = new URL(out.accept_url, window.location.origin).toString()
    } else {
      emit('close')
    }
  } catch (err) {
    // The server's own words for the refusals an admin can act on: already a
    // member, handle taken, today's invitations used up.
    serverError.value =
      err instanceof ApiHttpError && (err.status === 409 || err.status === 429)
        ? err.message
        : humanise(err)
  } finally {
    saving.value = false
  }
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.value)
    toast.success('Link copied')
  } catch {
    toast.error('Could not copy; select the link and copy it instead')
  }
}
</script>

<style scoped lang="scss">
.invite-link {
  display: grid;
  gap: var(--nb-spacing-12);

  &__note {
    margin: 0;
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
    line-height: 1.55;
  }
}
</style>
