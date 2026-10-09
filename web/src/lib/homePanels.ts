/**
 * Every panel Home can show, in its default order (Jose, 2026-10-09). A
 * person rearranges them, hides them or widens them from the customizer, and
 * a panel added in a later build appears for people who already customised,
 * in its default place relative to the panels they kept.
 */
export interface IHomePanelDef {
  id: string
  title: string
  /** One line for the customizer. */
  description: string
  defaultWide?: boolean
  defaultHidden?: boolean
  /** Next up is what Home is for: it can move, but not be hidden. */
  required?: boolean
}

export const HOME_PANELS: IHomePanelDef[] = [
  {
    id: 'next-up',
    title: 'Next up',
    description: 'Your work, ranked, with the reasons each card is there.',
    defaultWide: true,
    required: true,
  },
  {
    id: 'goals',
    title: 'Goals',
    description: 'How every goal stands, and the ones that need a look.',
    defaultWide: true,
  },
  {
    id: 'behind',
    title: 'Falling behind',
    description:
      'Late cards, stalled work and goals past their date in your spaces.',
  },
  {
    id: 'attention',
    title: 'Needs your attention',
    description: 'What colleagues did this week on cards you are on.',
  },
  {
    id: 'docs',
    title: 'Document updates',
    description: 'Pages that changed under you.',
  },
  {
    id: 'recent',
    title: 'Where you left off',
    description: 'The cards you changed most recently.',
    defaultHidden: true,
  },
  {
    id: 'spaces',
    title: 'Spaces',
    description: 'Every space, favourites first.',
    defaultWide: true,
  },
]

export interface IHomePanelPlace {
  id: string
  hidden: boolean
  wide: boolean
}

export function defaultLayout(): IHomePanelPlace[] {
  return HOME_PANELS.map((p) => ({
    id: p.id,
    hidden: Boolean(p.defaultHidden),
    wide: Boolean(p.defaultWide),
  }))
}

/**
 * A saved layout made whole: unknown panels dropped, a required one never
 * hidden, and any panel the save does not mention put back in its default
 * place, after the panel it follows by default.
 */
export function mergeLayout(
  saved: { id: string; hidden?: boolean; wide?: boolean }[] | null,
): IHomePanelPlace[] {
  if (!saved) return defaultLayout()
  const known = new Map(HOME_PANELS.map((p) => [p.id, p]))
  const out: IHomePanelPlace[] = []
  for (const s of saved) {
    const def = known.get(s.id)
    if (!def || out.some((o) => o.id === s.id)) continue
    out.push({
      id: s.id,
      hidden: def.required ? false : Boolean(s.hidden),
      wide: Boolean(s.wide),
    })
  }
  HOME_PANELS.forEach((def, index) => {
    if (out.some((o) => o.id === def.id)) return
    const before = HOME_PANELS.slice(0, index)
      .map((p) => out.findIndex((o) => o.id === p.id))
      .filter((i) => i >= 0)
    const at = before.length > 0 ? Math.max(...before) + 1 : 0
    out.splice(at, 0, {
      id: def.id,
      hidden: Boolean(def.defaultHidden),
      wide: Boolean(def.defaultWide),
    })
  })
  return out
}
