/**
 * How urgent a card is. A real field rather than a label group (Jose,
 * 2026-10-09), because Home ranks work by it. Absent means nobody has said,
 * which is most cards, and is shown as nothing rather than as "None".
 */
export type TPriority = 'low' | 'medium' | 'high' | 'urgent'

export const PRIORITY_OPTIONS: { label: string; value: TPriority | '' }[] = [
  { label: 'No priority', value: '' },
  { label: 'Urgent', value: 'urgent' },
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
]

export const PRIORITY_LABEL: Record<TPriority, string> = {
  urgent: 'Urgent',
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority',
}

/** Badge colour by consequence: only the two that ask for attention are loud. */
export const PRIORITY_VARIANT: Record<
  TPriority,
  'red' | 'orange' | 'blue' | 'grey'
> = {
  urgent: 'red',
  high: 'orange',
  medium: 'blue',
  low: 'grey',
}
