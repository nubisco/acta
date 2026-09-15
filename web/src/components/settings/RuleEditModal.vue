<template>
  <NbModal
    :open="open"
    :title="rule ? 'Edit rule' : 'New rule'"
    size="md"
    :close-on-overlay="!isDirty"
    @close="emit('close')"
  >
    <NbForm :id="formId" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />

      <NbTextInput
        :id="`${formId}-name`"
        ref="nameInput"
        v-model="name"
        label="Name"
        placeholder="Route bugs to In Progress"
        :error="errors.name"
        @blur="validateName"
      />

      <NbSelect
        :id="`${formId}-trigger`"
        v-model="trigger"
        label="When"
        :options="triggerOptions"
      />

      <!-- Conditions narrow which items a trigger applies to. Every field is
           optional and they combine, so leaving them all empty means the rule
           runs on every item the trigger fires for. -->
      <fieldset class="rule-edit__group">
        <legend class="rule-edit__legend">
          And the item matches
          <span class="rule-edit__hint">all optional</span>
        </legend>
        <div class="rule-edit__grid">
          <NbSelect
            :id="`${formId}-space`"
            v-model="condition.space"
            label="Space"
            placeholder="Any space"
            :options="spaceOptions"
          />
          <NbSelect
            :id="`${formId}-list`"
            v-model="condition.list"
            label="List"
            placeholder="Any list"
            :options="listOptions"
          />
          <NbSelect
            :id="`${formId}-label`"
            v-model="condition.label"
            label="Label"
            placeholder="Any label"
            :options="labelOptions"
          />
          <NbSelect
            :id="`${formId}-assignee`"
            v-model="condition.assignee"
            label="Assignee"
            placeholder="Anyone"
            :options="assigneeOptions"
          />
          <NbSelect
            :id="`${formId}-state`"
            v-model="condition.state"
            label="State"
            placeholder="Any state"
            :options="stateOptions"
          />
        </div>
      </fieldset>

      <NbSelect
        :id="`${formId}-action`"
        v-model="actionKind"
        label="Then"
        :options="actionOptions"
      />

      <NbSelect
        v-if="actionKind === 'move_item'"
        :id="`${formId}-action-list`"
        v-model="action.list"
        label="Move to list"
        :options="targetListOptions"
        :error="errors.action"
        @change="errors.action = undefined"
      />
      <NbSelect
        v-else-if="actionKind === 'apply_label'"
        :id="`${formId}-action-label`"
        v-model="action.label"
        label="Label to add"
        :options="labelOptions"
        :error="errors.action"
        @change="errors.action = undefined"
      />
      <NbSelect
        v-else-if="actionKind === 'assign'"
        :id="`${formId}-action-actor`"
        v-model="action.actor"
        label="Assign to"
        :options="assigneeOptions"
        :error="errors.action"
        @change="errors.action = undefined"
      />
      <NbTextInput
        v-else-if="actionKind === 'comment'"
        :id="`${formId}-action-body`"
        v-model="action.body"
        label="Comment"
        multiline
        :rows="3"
        placeholder="Thanks, we have picked this up."
        :error="errors.action"
      />
      <NbTextInput
        v-else-if="actionKind === 'call_webhook'"
        :id="`${formId}-action-url`"
        v-model="action.url"
        label="Webhook URL"
        placeholder="https://example.com/hook"
        :error="errors.action"
      />

      <NbCheckbox
        :id="`${formId}-enabled`"
        v-model="enabled"
        label="Active"
        hint="An inactive rule is kept but never runs."
      />
    </NbForm>

    <template #footer>
      <NbButton type="button" variant="secondary" @click="emit('close')">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        :form="formId"
        variant="primary"
        :loading="saving"
      >
        {{ rule ? 'Save rule' : 'Create rule' }}
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * The rules editor.
 *
 * Rules were data with no interface: the settings tab said so in a banner and
 * showed an empty audit table, which told anyone who had not read the MCP
 * tool list nothing they could act on. The vocabulary is small and closed
 * (twelve triggers, five condition keys, six actions), so this is a form
 * rather than the open-ended automation canvas that phrase usually implies.
 */
import { computed, reactive, ref, watch } from 'vue'
import type { NbTextInput } from '@nubisco/ui'
import { useToast } from '@nubisco/ui'
import { api, newOpId as opId } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import {
  RULE_ACTIONS,
  RULE_TRIGGERS,
  formatCondition,
  parseCondition,
  type IRuleAction,
  type IRuleView,
  type TRuleActionKind,
} from '@/components/settings/rules'

const props = defineProps<{ open: boolean; rule: IRuleView | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const ws = useWorkspace()
const toast = useToast()

const formId = 'rule-edit-form'

const name = ref('')
const trigger = ref<string>('item.created')
const enabled = ref(true)
const actionKind = ref<TRuleActionKind>('move_item')
const action = reactive<IRuleAction>({ kind: 'move_item' })
const condition = reactive<{
  space?: string
  list?: string
  label?: string
  assignee?: string
  state?: string
}>({})

const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ name?: string; action?: string }>({})
const nameInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const triggerOptions = RULE_TRIGGERS.map((t) => ({
  label: t.label,
  value: t.value,
}))
const actionOptions = RULE_ACTIONS.map((a) => ({
  label: a.label,
  value: a.value,
}))
const stateOptions = [
  { label: 'Open', value: 'open' },
  { label: 'Done', value: 'done' },
  { label: 'Archived', value: 'archived' },
]

const spaces = computed(() =>
  (ws.overview.value?.spaces ?? []).filter((b) => !b.archived),
)

const spaceOptions = computed(() =>
  spaces.value.map((b) => ({ label: b.name, value: b.key })),
)

/**
 * Lists are per space, so narrowing by space narrows the list picker with it.
 * Without a space chosen there is no single set of lists to offer, so every
 * list in the workspace is offered by name, which is what the condition
 * matches on anyway.
 */
const listOptions = computed(() => {
  const source = condition.space
    ? spaces.value.filter((b) => b.key === condition.space)
    : spaces.value
  const names = new Set(source.flatMap((b) => b.lists.map((l) => l.name)))
  return [...names].map((n) => ({ label: n, value: n }))
})

/**
 * A move needs a list that exists on the item's own space, and the engine
 * resolves it by name. Offering the same set as the condition keeps the two
 * consistent.
 */
const targetListOptions = listOptions

const labelOptions = computed(() => {
  const names = new Set(
    (ws.overview.value?.labels ?? [])
      .filter(
        (l) =>
          !condition.space ||
          l.space_key === null ||
          l.space_key === condition.space,
      )
      .map((l) => l.name),
  )
  return [...names].map((n) => ({ label: n, value: n }))
})

// People only. An assignee condition or an assign action against a bot can
// never match, because agent actors are not assignable.
const assigneeOptions = computed(() =>
  (ws.overview.value?.actors ?? [])
    .filter((a) => a.kind === 'human')
    .map((a) => ({ label: a.name, value: a.handle })),
)

const isDirty = computed(() => name.value.trim() !== '')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const r = props.rule
    name.value = r?.name ?? ''
    trigger.value = r?.trigger ?? 'item.created'
    enabled.value = r?.enabled ?? true
    actionKind.value = r?.action.kind ?? 'move_item'

    for (const key of Object.keys(action) as (keyof IRuleAction)[])
      delete action[key]
    Object.assign(action, r?.action ?? { kind: 'move_item' })

    for (const key of Object.keys(condition) as (keyof typeof condition)[])
      delete condition[key]
    Object.assign(condition, parseCondition(r?.condition))

    serverError.value = ''
    errors.name = undefined
    errors.action = undefined
    requestAnimationFrame(() => nameInput.value?.focus())
  },
)

// Switching what a rule does must not carry the previous action's fields
// along, or a rule that moves an item keeps a stale label in its payload.
watch(actionKind, (kind) => {
  for (const key of Object.keys(action) as (keyof IRuleAction)[])
    delete action[key]
  action.kind = kind
  errors.action = undefined
})

function validateName(): void {
  errors.name = name.value.trim() ? undefined : 'Name the rule'
}

/** Every action but `complete` needs its one argument filled in. */
function validateAction(): void {
  const required: Partial<Record<TRuleActionKind, keyof IRuleAction>> = {
    move_item: 'list',
    apply_label: 'label',
    assign: 'actor',
    comment: 'body',
    call_webhook: 'url',
  }
  const field = required[actionKind.value]
  if (!field) {
    errors.action = undefined
    return
  }
  errors.action = String(action[field] ?? '').trim()
    ? undefined
    : 'Fill this in, or the rule does nothing'
}

async function submit(): Promise<void> {
  validateName()
  validateAction()
  if (errors.name || errors.action) return

  saving.value = true
  serverError.value = ''
  try {
    const conditionText = formatCondition(condition)
    const { results } = await api.ruleWrite([
      props.rule
        ? {
            op: 'update',
            op_id: opId(),
            id: props.rule.id,
            name: name.value.trim(),
            trigger: trigger.value,
            // Null, not an empty string: clearing a condition has to be
            // distinguishable from leaving it untouched.
            condition: conditionText || null,
            action: { ...action },
            enabled: enabled.value,
          }
        : {
            op: 'create',
            op_id: opId(),
            name: name.value.trim(),
            trigger: trigger.value,
            condition: conditionText || undefined,
            action: { ...action },
            enabled: enabled.value,
          },
    ])
    const bad = results.find((r) => !r.ok)
    if (bad) throw new Error((bad as { error: string }).error)
    toast.success(props.rule ? 'Rule saved' : 'Rule created')
    emit('saved')
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped lang="scss">
.rule-edit {
  &__group {
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    padding: var(--nb-spacing-12);
  }

  &__legend {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    padding-inline: var(--nb-spacing-4);
    font-size: var(--nb-type-body-sm-size);
  }

  &__hint {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--nb-spacing-12);
  }
}
</style>
