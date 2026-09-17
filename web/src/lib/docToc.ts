/**
 * What Acta feeds NbTableOfContents: the sections of a page, and how to find
 * each section's heading on screen.
 *
 * Whether the contents show at all (`tocWorthShowing`), whether a reader has
 * closed them (`tocClosed` in the doc chrome preferences) and whether they
 * dock or float stay with DocsView.
 */
import type { ITableOfContentsItem } from '@nubisco/ui/components/TableOfContents'
import { documentOutline } from '@/lib/docText'

/** The page's headings, in document order, as contents entries. */
export function tocItems(source: string): ITableOfContentsItem[] {
  return documentOutline(source).map((entry) => ({
    id: entry.slug,
    label: entry.text,
    level: entry.level,
  }))
}

/**
 * Finds a section's heading by its position, not its id.
 *
 * The reader puts the slug on each heading as its id, but the editor rebuilds
 * its headings as they are typed and gives them none. The outline and the
 * rendered headings are both in document order, so the nth entry is the nth
 * heading in either.
 */
export function headingByIndex(
  root: () => HTMLElement | null,
): (item: ITableOfContentsItem, index: number) => HTMLElement | null {
  return (_item, index) =>
    root()?.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')[index] ??
    null
}
