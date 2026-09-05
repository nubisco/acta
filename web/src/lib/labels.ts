import type { IOverview } from '@/types/api'

export type TBadgeVariant =
  'grey' | 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'primary'

/** Server label colors map onto the closed NbBadge variant set. */
const COLOR_TO_VARIANT: Record<string, TBadgeVariant> = {
  red: 'red',
  green: 'green',
  blue: 'blue',
  sky: 'blue',
  yellow: 'orange',
  orange: 'orange',
  purple: 'purple',
  pink: 'purple',
  lime: 'green',
  black: 'grey',
  grey: 'grey',
  gray: 'grey',
}

export function labelVariants(
  overview: IOverview | null,
): Map<string, TBadgeVariant> {
  const map = new Map<string, TBadgeVariant>()
  for (const label of overview?.labels ?? []) {
    const base = label.color.split('_')[0]
    map.set(label.name, COLOR_TO_VARIANT[base] ?? 'grey')
  }
  return map
}
