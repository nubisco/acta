/**
 * The rule vocabulary, as the server actually implements it.
 *
 * Both lists are deliberately narrower than what the API's schema would
 * accept, because the schema is wider than the engine.
 */

/**
 * Triggers.
 *
 * Only item events. `startRulesEngine` returns early unless the event's
 * entity is an item, so a rule triggered on `doc.created` or `space.updated`
 * is accepted, stored, listed as Active, and can never once fire. Offering
 * those in a picker would be manufacturing that bug for people.
 */
export const RULE_TRIGGERS = [
  { value: 'item.*', label: 'Any change to an item' },
  { value: 'item.created', label: 'Item created' },
  { value: 'item.updated', label: 'Item edited' },
  { value: 'item.moved', label: 'Item moved between lists' },
  { value: 'item.labeled', label: 'Label added or removed' },
  { value: 'item.assigned', label: 'Item assigned' },
  { value: 'item.completed', label: 'Item completed' },
  { value: 'item.reopened', label: 'Item reopened' },
  { value: 'item.archived', label: 'Item archived' },
  { value: 'item.restored', label: 'Item restored' },
  { value: 'item.blocked', label: 'Item blocked' },
  { value: 'item.unblocked', label: 'Item unblocked' },
] as const

/** What a rule can do. Mirrors `zRuleAction` on the server, one for one. */
export const RULE_ACTIONS = [
  { value: 'move_item', label: 'Move it to a list' },
  { value: 'apply_label', label: 'Add a label' },
  { value: 'assign', label: 'Assign it to someone' },
  { value: 'comment', label: 'Post a comment' },
  { value: 'complete', label: 'Mark it complete' },
  { value: 'call_webhook', label: 'Call a webhook' },
] as const

export type TRuleActionKind = (typeof RULE_ACTIONS)[number]['value']

export interface IRuleAction {
  kind: TRuleActionKind
  space?: string
  list?: string
  label?: string
  actor?: string
  body?: string
  url?: string
}

export interface IRuleView {
  id: string
  name: string
  trigger: string
  condition?: string
  action: IRuleAction
  enabled: boolean
}

/** The condition keys `parseEmbedQuery` accepts. Anything else fails to parse. */
export interface IRuleCondition {
  space?: string
  list?: string
  label?: string
  assignee?: string
  state?: string
}

export function parseCondition(condition: string | undefined): IRuleCondition {
  const out: IRuleCondition = {}
  for (const pair of (condition ?? '').split(/\s+/).filter(Boolean)) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx) as keyof IRuleCondition
    if (key in { space: 1, list: 1, label: 1, assignee: 1, state: 1 })
      out[key] = pair.slice(idx + 1)
  }
  return out
}

/**
 * Back to the `key=value` string the server stores. Empty values are dropped
 * rather than written as `label=`, which does not parse and would match
 * nothing.
 */
export function formatCondition(condition: IRuleCondition): string {
  return (['space', 'list', 'label', 'assignee', 'state'] as const)
    .filter((k) => condition[k])
    .map((k) => `${k}=${condition[k]}`)
    .join(' ')
}

/** What the rule does, in one line, for the table. */
export function describeAction(action: IRuleAction): string {
  switch (action.kind) {
    case 'move_item':
      return `Move to ${action.space ? `${action.space} · ` : ''}${action.list ?? ''}`
    case 'apply_label':
      return `Add label ${action.label ?? ''}`
    case 'assign':
      return `Assign to @${action.actor ?? ''}`
    case 'comment':
      return 'Post a comment'
    case 'complete':
      return 'Mark complete'
    case 'call_webhook':
      return `Call ${action.url ?? ''}`
    default:
      return action.kind
  }
}

/** The trigger, in the same words the picker used. */
export function describeTrigger(trigger: string): string {
  return RULE_TRIGGERS.find((t) => t.value === trigger)?.label ?? trigger
}
