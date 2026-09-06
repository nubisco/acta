/** Deterministic accent color from the @nubisco/ui chart palette. */
export function chartColorFor(seed: string): string {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `var(--nb-c-chart-${(hash % 8) + 1})`
}

/**
 * List-role accents, shared by board column headers and board tiles so the
 * same role always reads as the same color.
 */
export function roleColor(role?: string): string | undefined {
  switch (role) {
    case 'active':
      return 'var(--nb-c-primary)'
    case 'blocked':
      return 'var(--nb-c-status-error)'
    case 'review':
      return 'var(--nb-c-status-warning)'
    case 'done':
      return 'var(--nb-c-status-valid)'
    case 'inbox':
      return 'var(--nb-c-info)'
    default:
      return undefined
  }
}
