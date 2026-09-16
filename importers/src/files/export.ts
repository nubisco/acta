/**
 * Pages into the files of a markdown export.
 *
 * `attachment:<id>` means something only inside the instance that issued the
 * id, so an export cannot leave it in the text. Every uploaded file a page
 * embeds is written into `attachments/` at the root of the export and the
 * reference becomes the relative path to it. A link attachment becomes the
 * address it links to. A reference that resolves to neither is left exactly
 * as written and reported, so the caller can say so rather than hand over a
 * file with a picture silently missing.
 *
 * The layout is the one `planPageTree` reads, which is what makes an export
 * import back as the same tree.
 */

import { writeFrontmatter } from './frontmatter'
import { attachmentIdOf, rewriteLinks, wrapTarget } from './links'
import {
  dirname,
  relativePath,
  safeAssetName,
  titleToFilename,
  uniqueName,
} from './paths'

export interface IExportPage {
  slug: string
  title: string
  body: string
  tags?: string[]
  children: IExportPage[]
}

/** What an attachment id turned out to be. */
export type TResolvedAttachment =
  { kind: 'file'; filename: string } | { kind: 'url'; url: string }

export interface IExportFile {
  path: string
  /** Page text, or the id of the attachment whose bytes belong here. */
  content: { text: string } | { attachment: string }
}

export interface IExportPlan {
  files: IExportFile[]
  /** Attachment ids a page refers to that could not be resolved. */
  unresolved: { slug: string; id: string }[]
  /** How many attachment files the export carries. */
  assetCount: number
}

export const ATTACHMENTS_DIR = 'attachments'

/** Every attachment id referenced from a body. */
export function attachmentRefs(body: string): string[] {
  const ids = new Set<string>()
  rewriteLinks(body, (match) => {
    const id = attachmentIdOf(match.target)
    if (id) ids.add(id)
    return null
  })
  return [...ids]
}

/**
 * The files for `roots` and their descendants.
 *
 * `resolve` says what each referenced id is. The bytes are the caller's
 * business: this module is shared with Bun and never fetches anything.
 */
export function planMarkdownExport(
  roots: IExportPage[],
  resolve: (id: string) => TResolvedAttachment | null,
): IExportPlan {
  const files: IExportFile[] = []
  const unresolved: { slug: string; id: string }[] = []
  const assetPaths = new Map<string, string>()
  const takenAssets = new Set<string>()

  const assetPath = (id: string, filename: string): string => {
    const known = assetPaths.get(id)
    if (known) return known
    const path = `${ATTACHMENTS_DIR}/${uniqueName(safeAssetName(filename), takenAssets)}`
    assetPaths.set(id, path)
    files.push({ path, content: { attachment: id } })
    return path
  }

  const writePages = (pages: IExportPage[], dir: string) => {
    const taken = new Set<string>()
    pages.forEach((page, index) => {
      const name = uniqueName(titleToFilename(page.title), taken, ' ')
      const path = dir ? `${dir}/${name}.md` : `${name}.md`
      const body = rewriteLinks(page.body, (match) => {
        const id = attachmentIdOf(match.target)
        if (!id) return null
        const resolved = resolve(id)
        if (!resolved) {
          unresolved.push({ slug: page.slug, id })
          return null
        }
        const target =
          resolved.kind === 'url'
            ? resolved.url
            : relativePath(dirname(path), assetPath(id, resolved.filename))
        const title = match.title ? ` ${match.title}` : ''
        return `${match.image ? '!' : ''}[${match.text}](${wrapTarget(target)}${title})${match.attrs}`
      })
      const header = writeFrontmatter({
        title: page.title,
        tags: page.tags,
        order: pages.length > 1 ? index + 1 : undefined,
      })
      files.push({ path, content: { text: `${header}${body}\n` } })
      if (page.children.length > 0)
        writePages(page.children, dir ? `${dir}/${name}` : name)
    })
  }

  writePages(roots, '')
  // Pages first, then the files they point at, so a listing reads naturally.
  files.sort((a, b) => {
    const aAsset = 'attachment' in a.content ? 1 : 0
    const bAsset = 'attachment' in b.content ? 1 : 0
    return aAsset - bAsset
  })
  return { files, unresolved, assetCount: assetPaths.size }
}
