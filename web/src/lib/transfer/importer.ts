/**
 * Prepared sources into real pages, through the same API every other write
 * uses.
 *
 * Pictures and files a page refers to become attachments on that page, and
 * the reference becomes `attachment:<id>`, whatever form it arrived in: a path
 * beside the file, a picture inside a Word document, a `data:` URI, or an
 * address on the web. A link to another page in the same import becomes a
 * `[[doc:...]]` reference.
 *
 * Every body is stored in the editor's own serialization, so opening a page
 * and saving it changes nothing.
 */
import { newOpId } from '@/api/client'
import {
  attachmentIdOf,
  basename,
  extFromMime,
  flattenPages,
  isMarkdownPath,
  mimeFromName,
  planPageTree,
  resolveRelative,
  rewriteLinks,
  safeAssetName,
  stem,
  wrapTarget,
  type IPlannedPage,
} from '@nubisco/acta-importers/files'
import {
  DOC_SLUG_RE,
  slugify,
  type TDocOp,
  type TOpResult,
} from '@nubisco/acta-shared'
import { normalizeMarkdown } from './normalize'
import { decodeDataUri, type IPreparedImport } from './sources'

/** The calls an import makes, injectable so the whole run is testable. */
export interface IImportApi {
  docTree: () => Promise<{ docs: { slug: string }[] }>
  docWrite: (ops: TDocOp[]) => Promise<{ results: TOpResult[] }>
  attachmentUpload: (
    owner: { doc: string },
    file: File,
  ) => Promise<{ id: string }>
  /**
   * A picture from the web, or null when it cannot be read. The browser can
   * only read another site's image when that site allows it.
   */
  fetchRemote?: (
    url: string,
  ) => Promise<{ bytes: Uint8Array; mime: string } | null>
}

export interface IImportTarget {
  /** The page the import lands under, or the top level when absent. */
  parent?: string
}

export interface IImportProgress {
  done: number
  total: number
  label: string
}

export interface IImportResult {
  pages: { slug: string; title: string }[]
  issues: string[]
}

/** The slug a page gets under `parent`, never one already taken. */
function claimSlug(
  title: string,
  parent: string | undefined,
  taken: Set<string>,
): string {
  const base = slugify(title).slice(0, 80).replace(/-+$/, '') || 'page'
  const prefix = parent ? `${parent}/` : ''
  let candidate = `${prefix}${base}`
  for (let n = 2; taken.has(candidate) || !DOC_SLUG_RE.test(candidate); n++)
    candidate = `${prefix}${base}-${n}`
  taken.add(candidate)
  return candidate
}

/** A picture fetched from the web by the browser, when the site allows it. */
export async function fetchRemoteInBrowser(
  url: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
    if (!res.ok) return null
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    if (!mime.startsWith('image/')) return null
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime }
  } catch {
    return null
  }
}

function toFile(bytes: Uint8Array, name: string, mime: string): File {
  return new File([bytes as BlobPart], name, { type: mime })
}

/** The asset a relative path names, forgiving of case and of URL escapes. */
function findAsset(
  assets: Map<string, Uint8Array>,
  lowerIndex: Map<string, string>,
  baseDir: string,
  target: string,
): string | null {
  let decoded = target.split(/[?#]/)[0]
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // A stray `%` is part of the name.
  }
  const path = resolveRelative(baseDir, decoded)
  if (assets.has(path)) return path
  return lowerIndex.get(path.toLowerCase()) ?? null
}

export async function runImport(
  prepared: IPreparedImport,
  target: IImportTarget,
  api: IImportApi,
  onProgress?: (progress: IImportProgress) => void,
): Promise<IImportResult> {
  const issues = new Set(prepared.issues)
  const roots = planPageTree(prepared.sources)
  const pages = flattenPages(roots)
  if (pages.length === 0)
    return {
      pages: [],
      issues: [
        ...issues,
        'Nothing to import: pick markdown, HTML or Word files, a folder, or a zip.',
      ],
    }

  const { docs } = await api.docTree()
  const taken = new Set(docs.map((doc) => doc.slug))
  const slugs = new Map<IPlannedPage, string>()
  const bySource = new Map<string, string>()
  const assign = (list: IPlannedPage[], parent: string | undefined) => {
    for (const page of list) {
      const slug = claimSlug(page.title, parent, taken)
      slugs.set(page, slug)
      if (page.sourcePath) bySource.set(page.sourcePath.toLowerCase(), slug)
      assign(page.children, slug)
    }
  }
  assign(roots, target.parent)

  const lowerIndex = new Map<string, string>()
  for (const path of prepared.assets.keys())
    lowerIndex.set(path.toLowerCase(), path)

  const created: { slug: string; title: string }[] = []
  const parentOf = new Map<IPlannedPage, string | undefined>()
  const walkParents = (list: IPlannedPage[], parent: string | undefined) => {
    for (const page of list) {
      parentOf.set(page, parent)
      walkParents(page.children, slugs.get(page))
    }
  }
  walkParents(roots, target.parent)

  let done = 0
  for (const page of pages) {
    let slug = slugs.get(page)!
    onProgress?.({ done, total: pages.length, label: page.title })

    // What the body needs uploading, keyed by what it is, so a picture used
    // twice on a page is one attachment.
    type TUpload = {
      key: string
      name: string
      mime: string
      load: () => Promise<Uint8Array | null>
    }
    const uploads = new Map<string, TUpload>()
    const plan = (raw: string, image: boolean): TUpload | null => {
      const trimmed = raw.trim()
      if (!trimmed || attachmentIdOf(trimmed)) return null
      if (/^data:/i.test(trimmed)) {
        const decoded = decodeDataUri(trimmed)
        if (!decoded) return null
        return {
          key: trimmed,
          name: `image.${extFromMime(decoded.mime)}`,
          mime: decoded.mime,
          load: async () => decoded.bytes,
        }
      }
      if (/^https?:\/\//i.test(trimmed)) {
        if (!image || !api.fetchRemote) return null
        const name = safeAssetName(
          basename(new URL(trimmed).pathname) || 'image',
        )
        return {
          key: trimmed,
          name,
          mime: mimeFromName(name),
          load: async () => {
            const got = await api.fetchRemote!(trimmed)
            return got ? got.bytes : null
          },
        }
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('#'))
        return null
      const path = findAsset(prepared.assets, lowerIndex, page.baseDir, trimmed)
      if (!path) return null
      return {
        key: path,
        name: basename(path),
        mime: mimeFromName(path),
        load: async () => prepared.assets.get(path) ?? null,
      }
    }

    const missing = new Set<string>()
    rewriteLinks(page.body, (match) => {
      const upload = plan(match.target, match.image)
      if (upload) uploads.set(upload.key, upload)
      else if (
        match.image &&
        !/^([a-z][a-z0-9+.-]*:|#)/i.test(match.target) &&
        match.target.trim()
      )
        missing.add(match.target)
      return null
    })
    for (const name of missing)
      issues.add(
        `"${page.title}" refers to ${name}, which was not in the import.`,
      )

    // Created empty when there is anything to attach, because an attachment
    // needs its page to exist. The body lands once, complete, in the same
    // import, rather than with references that point nowhere.
    const resolveBody = (ids: Map<string, string>) =>
      normalizeMarkdown(
        rewriteLinks(page.body, (match) => {
          const target = match.target.trim()
          if (/^https?:\/\//i.test(target) && !match.image) return null
          const upload = plan(target, match.image)
          const id = upload ? ids.get(upload.key) : undefined
          const title = match.title ? ` ${match.title}` : ''
          if (id) {
            // A file that is not a picture is still embedded with `![]`,
            // which is how the reader draws a download chip for it.
            return `![${match.text}](${wrapTarget(`attachment:${id}`)}${title})${match.attrs}`
          }
          if (!match.image && isMarkdownPath(target)) {
            let decoded = target.split('#')[0]
            try {
              decoded = decodeURIComponent(decoded)
            } catch {
              // Keep it as written.
            }
            const linked = bySource.get(
              resolveRelative(page.baseDir, decoded).toLowerCase(),
            )
            if (linked) {
              const text = match.text.trim()
              return text && text !== linked && text !== stem(target)
                ? `[[doc:${linked}|${text.replace(/[|\]]/g, ' ')}]]`
                : `[[doc:${linked}]]`
            }
          }
          return null
        }),
      )

    const parent = parentOf.get(page)
    const createOp = (candidate: string, body: string): TDocOp => ({
      op: 'create',
      op_id: newOpId(),
      slug: candidate,
      title: page.title,
      parent,
      body,
      layout: 'default',
      tags: page.tags.slice(0, 20),
    })
    const firstBody = uploads.size > 0 ? '' : resolveBody(new Map())
    let result = (await api.docWrite([createOp(slug, firstBody)])).results[0]
    // A slug held by an archived page is not in the tree but is still taken.
    for (
      let attempt = 0;
      !result.ok && /already exists/.test(result.error) && attempt < 20;
      attempt++
    ) {
      const retry = claimSlug(`${page.title}`, parent, taken)
      result = (await api.docWrite([createOp(retry, firstBody)])).results[0]
      if (result.ok) {
        slug = retry
        slugs.set(page, retry)
        for (const child of page.children) parentOf.set(child, retry)
      }
    }
    if (!result.ok)
      throw new Error(`Could not create "${page.title}": ${result.error}`)

    if (uploads.size > 0) {
      const ids = new Map<string, string>()
      for (const upload of uploads.values()) {
        const bytes = await upload.load()
        if (!bytes) {
          issues.add(
            `A picture in "${page.title}" could not be copied (${upload.key.slice(0, 120)}). Its site does not allow it, so it still points at the original address.`,
          )
          continue
        }
        try {
          const uploaded = await api.attachmentUpload(
            { doc: slug },
            toFile(bytes, upload.name, upload.mime),
          )
          ids.set(upload.key, uploaded.id)
        } catch {
          issues.add(`${upload.name} could not be attached to "${page.title}".`)
        }
      }
      const body = resolveBody(ids)
      const replaced = (
        await api.docWrite([
          {
            op: 'replace',
            op_id: newOpId(),
            ref: slug,
            if_rev: result.rev ?? 1,
            body,
          },
        ])
      ).results[0]
      if (!replaced.ok)
        throw new Error(`Could not write "${page.title}": ${replaced.error}`)
    }

    created.push({ slug, title: page.title })
    done++
  }
  onProgress?.({ done, total: pages.length, label: '' })
  return { pages: created, issues: [...issues] }
}
