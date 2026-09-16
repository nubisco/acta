/**
 * What a person picked, turned into markdown sources and loose files.
 *
 * Runs in the browser on purpose. A `.docx` is a zip of XML, and a `.zip` is
 * a zip: reading either needs a decompressor and, for Word, a converter with a
 * sizeable dependency tree. Doing that here keeps all of it off the server,
 * which also runs as a Cloudflare Worker, and means the file never leaves the
 * machine until it is already a page.
 */
import { unzipSync } from 'fflate'
import {
  basename,
  extname,
  isMarkdownPath,
  normalisePath,
  splitByHeadings,
  stem,
  titleFromFilename,
  type IMarkdownSource,
  type IPlannedPage,
  type ISplitPage,
} from '@nubisco/acta-importers/files'
import { convertHtml } from './domTree'
import { normalizeMarkdown } from './normalize'

/** One file from the input, after any zip has been opened. */
export interface IInputEntry {
  path: string
  bytes: Uint8Array
}

export interface IPrepareOptions {
  /**
   * Cut HTML and Word documents into a page per heading at this level or
   * shallower. Off when absent.
   */
  splitLevel?: number
}

export interface IPreparedImport {
  sources: IMarkdownSource[]
  /** Every non-page file, by path, for images and attachments to resolve to. */
  assets: Map<string, Uint8Array>
  issues: string[]
}

const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])

/** Files nobody meant to import, which zips and folders carry along. */
function isNoise(path: string): boolean {
  const parts = path.split('/')
  return parts.some(
    (part) =>
      part === '__MACOSX' ||
      part === '.DS_Store' ||
      part === 'Thumbs.db' ||
      part === 'desktop.ini' ||
      part.startsWith('._'),
  )
}

/**
 * Picked files into entries, with every `.zip` opened in place.
 *
 * A zip's entries sit under nothing, so a zip holding `Handbook.md` imports
 * the same as picking `Handbook.md`. A folder picked in the browser arrives
 * with `webkitRelativePath`, which keeps the folder as the first segment, so
 * the folder itself becomes the top page.
 */
export async function readInputs(files: File[]): Promise<IInputEntry[]> {
  const entries: IInputEntry[] = []
  for (const file of files) {
    const path = normalisePath(
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
        file.name,
    )
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (extname(path) === 'zip') {
      const unzipped = unzipSync(bytes)
      for (const [name, content] of Object.entries(unzipped)) {
        if (name.endsWith('/')) continue
        entries.push({ path: normalisePath(name), bytes: content })
      }
      continue
    }
    entries.push({ path, bytes })
  }
  return entries.filter((entry) => entry.path && !isNoise(entry.path))
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/\r\n?/g, '\n')
}

/** A `data:` URI's bytes and type, or null when it is not one. */
export function decodeDataUri(
  uri: string,
): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(uri.trim())
  if (!match) return null
  const mime = match[1] || 'text/plain'
  const base64 = /;base64/i.test(match[2])
  try {
    const payload = decodeURIComponent(match[3])
    if (!base64) return { mime, bytes: new TextEncoder().encode(payload) }
    const binary = atob(payload.replace(/\s+/g, ''))
    return { mime, bytes: Uint8Array.from(binary, (ch) => ch.charCodeAt(0)) }
  } catch {
    return null
  }
}

/** A Word document as HTML, with its pictures pulled out as named files. */
async function docxToHtml(
  entry: IInputEntry,
  assets: Map<string, Uint8Array>,
): Promise<{ html: string; messages: string[] }> {
  const mammoth = (await import('mammoth')).default
  const folder = `${entry.path}.images`
  let count = 0
  const buffer = entry.bytes.buffer.slice(
    entry.bytes.byteOffset,
    entry.bytes.byteOffset + entry.bytes.byteLength,
  ) as ArrayBuffer
  // `arrayBuffer` is what mammoth's browser build reads. Its Node build, which
  // the test runner loads, reads `buffer`, and takes an ArrayBuffer there too.
  const input = { arrayBuffer: buffer, buffer } as { arrayBuffer: ArrayBuffer }
  const result = await mammoth.convertToHtml(input, {
    // Word's own names for the paragraph styles people use for these.
    styleMap: [
      "p[style-name='Title'] => h1:fresh",
      "p[style-name='Subtitle'] => h2:fresh",
      "p[style-name='Quote'] => blockquote:fresh",
      "p[style-name='Intense Quote'] => blockquote:fresh",
    ],
    // Files beside the document rather than data URIs, so they become
    // attachments the same way a picture in a folder does.
    convertImage: mammoth.images.imgElement(async (image) => {
      count++
      const ext = (image.contentType.split('/')[1] ?? 'bin').replace(
        'jpeg',
        'jpg',
      )
      const name = `image-${count}.${ext.replace(/[^a-z0-9]/gi, '')}`
      assets.set(
        `${folder}/${name}`,
        new Uint8Array(await image.readAsArrayBuffer()),
      )
      return { src: `${basename(folder)}/${name}` }
    }),
  })
  return {
    html: result.value,
    messages: result.messages
      .filter((message) => message.type === 'warning')
      .map((message) => message.message),
  }
}

/** A split tree into planned pages, all resolving links from `baseDir`. */
function toPlanned(page: ISplitPage, baseDir: string): IPlannedPage {
  return {
    title: page.title,
    body: page.body,
    tags: [],
    baseDir,
    children: page.children.map((child) => toPlanned(child, baseDir)),
  }
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

/**
 * Every page-shaped entry as a markdown source, and every other entry as an
 * asset. HTML and Word are converted here, and cut at headings when asked.
 */
export async function prepareImport(
  entries: IInputEntry[],
  options: IPrepareOptions = {},
): Promise<IPreparedImport> {
  const sources: IMarkdownSource[] = []
  const assets = new Map<string, Uint8Array>()
  const issues = new Set<string>()
  const documents: { entry: IInputEntry; kind: 'html' | 'docx' }[] = []

  for (const entry of entries) {
    const ext = extname(entry.path)
    if (isMarkdownPath(entry.path)) {
      sources.push({ path: entry.path, markdown: decodeText(entry.bytes) })
    } else if (HTML_EXTENSIONS.has(ext)) {
      documents.push({ entry, kind: 'html' })
    } else if (ext === 'docx') {
      documents.push({ entry, kind: 'docx' })
    } else {
      assets.set(entry.path, entry.bytes)
    }
  }

  for (const { entry, kind } of documents) {
    let html: string
    if (kind === 'docx') {
      try {
        const converted = await docxToHtml(entry, assets)
        html = converted.html
        if (converted.messages.length > 0)
          issues.add(
            `${basename(entry.path)}: some Word formatting has no equivalent and was left out.`,
          )
      } catch {
        issues.add(`${basename(entry.path)} could not be read as a Word file.`)
        continue
      }
    } else {
      html = decodeText(entry.bytes)
    }
    const converted = convertHtml(html)
    for (const issue of converted.issues)
      issues.add(`${basename(entry.path)}: ${issue}`)

    // The source path keeps the document's own name with a markdown
    // extension, so it takes the same place in the tree a `.md` file would.
    const path = `${dirOf(entry.path)}${dirOf(entry.path) ? '/' : ''}${stem(entry.path)}.md`
    if (options.splitLevel) {
      // Canonical first, so a heading the converter wrote in some other
      // shape still counts as a heading when the document is cut.
      const canonical = normalizeMarkdown(converted.markdown)
      const tree = splitByHeadings(
        canonical,
        options.splitLevel,
        converted.title ?? titleFromFilename(entry.path),
      )
      sources.push({
        path,
        markdown: tree.body,
        title: tree.title,
        children: tree.children.map((child) =>
          toPlanned(child, dirOf(entry.path)),
        ),
      })
      continue
    }
    sources.push({
      path,
      markdown: converted.markdown,
      title: converted.title,
    })
  }

  return { sources, assets, issues: [...issues] }
}
