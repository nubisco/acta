/**
 * An in-memory Acta for the import and export tests.
 *
 * Just enough of the API to hold pages and attachments the way the server
 * does: slugs are unique, a replace needs the current rev, and an attachment
 * belongs to a page. The import and export code under test takes these calls
 * as a parameter, so what runs here is the same code the modal runs.
 */
import type { TDocOp, TOpResult } from '@nubisco/acta-shared'
import type { IImportApi } from '@/lib/transfer/importer'
import type { IExportApi, IExportDoc } from '@/lib/transfer/exporter'

export interface IFakeDoc {
  slug: string
  title: string
  parent?: string
  body: string
  tags: string[]
  rev: number
}

export interface IFakeAttachment {
  id: string
  doc: string
  filename: string
  mime: string
  bytes: Uint8Array
  kind: 'file' | 'url'
  url?: string
}

/** A picture on another site, and whether that site lets a browser read it. */
export interface IFakeRemote {
  bytes: Uint8Array
  mime: string
  cors: boolean
}

export class FakeActa {
  docs: IFakeDoc[] = []
  attachments: IFakeAttachment[] = []
  /** The web, by URL. Anything not here cannot be fetched by anyone. */
  web = new Map<string, IFakeRemote>()
  /** Every URL the browser tried to read, in order. */
  browserReads: string[] = []
  /** Every URL the server was asked to copy, in order. */
  serverCopies: string[] = []
  /** The most server copies that were running at the same moment. */
  maxConcurrentCopies = 0
  private copiesRunning = 0
  private seq = 0

  addDoc(doc: Partial<IFakeDoc> & { slug: string; title: string }): IFakeDoc {
    const row = { body: '', tags: [], rev: 1, ...doc }
    this.docs.push(row)
    return row
  }

  addAttachment(
    doc: string,
    filename: string,
    bytes: Uint8Array,
    mime = 'image/png',
  ): IFakeAttachment {
    const row: IFakeAttachment = {
      id: `att_${(++this.seq).toString().padStart(4, '0')}`,
      doc,
      filename,
      mime,
      bytes,
      kind: 'file',
    }
    this.attachments.push(row)
    return row
  }

  /** Deletes a page and the attachments it owns, as the server does. */
  deleteDoc(slug: string): void {
    this.docs = this.docs.filter((doc) => doc.slug !== slug)
    this.attachments = this.attachments.filter((a) => a.doc !== slug)
  }

  doc(slug: string): IFakeDoc {
    const found = this.docs.find((doc) => doc.slug === slug)
    if (!found) throw new Error(`no doc ${slug}`)
    return found
  }

  childrenOf(slug: string | undefined): IFakeDoc[] {
    return this.docs.filter((doc) => doc.parent === slug)
  }

  /** The flat depth-ordered tree the server returns. */
  tree(): { slug: string; title: string; depth: number }[] {
    const out: { slug: string; title: string; depth: number }[] = []
    const walk = (parent: string | undefined, depth: number) => {
      for (const doc of this.childrenOf(parent)) {
        out.push({ slug: doc.slug, title: doc.title, depth })
        walk(doc.slug, depth + 1)
      }
    }
    walk(undefined, 0)
    return out
  }

  write(op: TDocOp): TOpResult {
    if (op.op === 'create') {
      if (this.docs.some((doc) => doc.slug === op.slug))
        return {
          op_id: op.op_id,
          ok: false,
          error: `doc ${op.slug} already exists`,
        }
      this.addDoc({
        slug: op.slug,
        title: op.title,
        parent: op.parent,
        body: op.body,
        tags: op.tags,
      })
      return { op_id: op.op_id, ok: true, slug: op.slug, rev: 1 }
    }
    if (op.op === 'replace') {
      const doc = this.doc(op.ref)
      if (doc.rev !== op.if_rev)
        return { op_id: op.op_id, ok: false, error: 'rev conflict' }
      doc.body = op.body
      doc.rev++
      return { op_id: op.op_id, ok: true, slug: doc.slug, rev: doc.rev }
    }
    return { op_id: op.op_id, ok: false, error: `unsupported ${op.op}` }
  }

  importApi(): IImportApi {
    return {
      docTree: async () => ({ docs: this.tree() }),
      docWrite: async (ops) => ({ results: ops.map((op) => this.write(op)) }),
      attachmentUpload: async (owner, file) => {
        const bytes = new Uint8Array(await file.arrayBuffer())
        return this.addAttachment(owner.doc, file.name, bytes, file.type)
      },
      fetchRemote: async (url) => {
        this.browserReads.push(url)
        const found = this.web.get(url)
        return found?.cors ? { bytes: found.bytes, mime: found.mime } : null
      },
      attachmentFetchRemote: async (owner, url) => {
        this.serverCopies.push(url)
        this.copiesRunning++
        this.maxConcurrentCopies = Math.max(
          this.maxConcurrentCopies,
          this.copiesRunning,
        )
        try {
          // A real request takes a moment, which is what lets the concurrency
          // cap be observed at all.
          await new Promise((resolve) => setTimeout(resolve, 1))
          const found = this.web.get(url)
          if (!found) throw new Error('422 could not fetch that image')
          const name = url.split('/').pop() || 'image'
          return this.addAttachment(owner.doc, name, found.bytes, found.mime)
        } finally {
          this.copiesRunning--
        }
      },
      attachmentBytes: async (id) => {
        const found = this.attachments.find((a) => a.id === id)
        return found?.kind === 'file'
          ? { bytes: found.bytes, mime: found.mime }
          : null
      },
    }
  }

  exportApi(): IExportApi {
    return {
      docTree: async () => ({ docs: this.tree() }),
      docGet: async (slug): Promise<IExportDoc> => {
        const doc = this.doc(slug)
        return {
          slug: doc.slug,
          title: doc.title,
          tags: doc.tags,
          body: doc.body,
          attachments: this.attachments
            .filter((a) => a.doc === slug)
            .map((a) => ({
              id: a.id,
              filename: a.filename,
              mime: a.mime,
              size: a.bytes.byteLength,
              url: a.url ?? `/api/v1/attachments/${a.id}`,
            })),
        }
      },
      attachment: async (id) => {
        const found = this.attachments.find((a) => a.id === id)
        if (!found) return null
        if (found.kind === 'url') return { kind: 'url', url: found.url! }
        return {
          kind: 'file',
          bytes: found.bytes,
          mime: found.mime,
          filename: found.filename,
        }
      },
    }
  }
}

/** A 1x1 PNG. */
export const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  ),
  (ch) => ch.charCodeAt(0),
)

/** A blob as a File, the way a person would pick the downloaded export. */
export async function asFile(
  blob: Blob,
  name: string,
  relativePath?: string,
): Promise<File> {
  const file = new File([await blob.arrayBuffer()], name, { type: blob.type })
  if (relativePath)
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

export function textFile(
  name: string,
  text: string,
  relativePath?: string,
): File {
  const file = new File([text], name, { type: 'text/plain' })
  if (relativePath)
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

export function bytesFile(
  name: string,
  bytes: Uint8Array,
  relativePath?: string,
): File {
  const file = new File([bytes as BlobPart], name)
  if (relativePath)
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}
