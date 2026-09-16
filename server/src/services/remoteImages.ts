/**
 * A picture on another site, copied into an attachment.
 *
 * Importing a document keeps its pictures, and a picture that stays a link to
 * somebody else's server breaks the day that server moves it. The browser
 * copies what it can, but it can only read another site's image when that
 * site allows it (CORS), and most do not. This is the fallback: the server
 * fetches the picture and stores it exactly as an upload would be stored.
 *
 * That makes it an SSRF sink with the same shape as link previews, so every
 * byte comes through `safeFetchBytes` and every rule in core/safeFetch.ts
 * applies. On top of that guard, three checks belong to this use:
 *
 *  - The response must be an image by its declared type AND by its first
 *    bytes, and the two must agree. A header is whatever the far end chose to
 *    send, and HTML labelled `image/png` is exactly what an attacker sends.
 *  - A size cap that suits pictures, refused rather than truncated, because
 *    half an image is a broken file.
 *  - An SVG is stored as `image/svg+xml`, so it is served with the locked-down
 *    headers every SVG attachment already gets (see `attachmentHeaders`).
 *
 * Every failure, from "that address is private" to "the site is down" to
 * "that was not an image", answers with the same status and the same words.
 * Telling them apart would turn this endpoint into a way to map which internal
 * addresses exist. Timing does not leak that either: a private address is
 * refused before any connection is attempted, whether or not anything lives
 * there.
 */
import { z } from 'zod'
import type { ICtx } from '../core/ctx'
import { ApiError } from '../core/ctx'
import {
  realFetchDeps,
  safeFetchBytes,
  type IFetchDeps,
} from '../core/safeFetch'
import { docBySlug } from '../core/store'
import { attachmentUpload, type AttachmentStore } from './attachments'

/** 10 MB. Generous for a picture in a document, small for a Worker's heap. */
export const REMOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** A picture can be larger than a page head, so it gets longer than a preview. */
export const REMOTE_IMAGE_TIMEOUT_MS = 15_000

/** The one answer every failure gets. See the file header for why. */
export const REMOTE_IMAGE_FAILURE = 'could not fetch that image'

export const zAttachmentFetch = z.object({
  doc: z.string().min(1).max(300),
  url: z.string().min(1).max(2000),
})
export type TAttachmentFetch = z.infer<typeof zAttachmentFetch>

/** The image types an attachment renders inline, and their extensions. */
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
}

/** A declared content type, lowercased and without parameters. */
function declaredType(header: string): string | null {
  const type = header.split(';')[0].trim().toLowerCase()
  // `image/jpg` is not a registered type, and plenty of servers send it.
  const normalised = type === 'image/jpg' ? 'image/jpeg' : type
  return normalised in IMAGE_TYPES ? normalised : null
}

function startsWith(bytes: Uint8Array, prefix: number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false
  return prefix.every((value, i) => bytes[at + i] === value)
}

const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0))

/**
 * What the bytes are, read from the bytes, or null.
 *
 * Magic numbers for the raster formats. An SVG has none, so it is read as
 * text: the first thing after an optional BOM, XML declaration, comments and
 * doctype must be an `<svg` element. An HTML page fails that, which is the
 * case that matters.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a')))
    return 'image/gif'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8))
    return 'image/webp'
  if (
    startsWith(bytes, ascii('ftyp'), 4) &&
    (startsWith(bytes, ascii('avif'), 8) || startsWith(bytes, ascii('avis'), 8))
  )
    return 'image/avif'
  return isSvg(bytes) ? 'image/svg+xml' : null
}

function isSvg(bytes: Uint8Array): boolean {
  // Lossy decoding is fine here: the test below needs ASCII markup at the
  // very start, which binary junk and an HTML page both fail.
  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096))
  let rest = text.replace(/^\uFEFF/, '')
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '')
    const prolog = /^(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg[^>]*>)/i
    const match = prolog.exec(trimmed)
    if (!match) return /^<svg[\s>/]/.test(trimmed)
    rest = trimmed.slice(match[0].length)
  }
}

/** A filename for the attachment, from the URL, with the right extension. */
export function remoteImageName(url: string, mime: string): string {
  let base = 'image'
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    let decoded = last
    try {
      decoded = decodeURIComponent(last)
    } catch {
      // A stray `%` is part of the name.
    }
    const stem = decoded
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 120)
    if (stem) base = stem
  } catch {
    // Unparseable URLs never get this far, but the name is not worth a throw.
  }
  return `${base}.${IMAGE_TYPES[mime]}`
}

/**
 * Fetch `input.url` and attach it to `input.doc`, or throw one uniform 422.
 *
 * The page is looked up first, so a request naming a page that does not exist
 * never makes an outbound request at all.
 */
export async function attachmentFetchRemote(
  ctx: ICtx,
  store: AttachmentStore,
  input: TAttachmentFetch,
  deps: IFetchDeps = realFetchDeps(),
) {
  await docBySlug(ctx, input.doc)

  let fetched: { bytes: Uint8Array; mime: string; url: string }
  try {
    const res = await safeFetchBytes(
      input.url,
      { ...deps, timeoutMs: deps.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS },
      {
        accept:
          'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml',
        maxBytes: REMOTE_IMAGE_MAX_BYTES,
        overflow: 'refuse',
        userAgent: 'ActaImageImport/1.0 (+https://nubisco.io/acta)',
      },
    )
    const declared = declaredType(res.contentType)
    const sniffed = sniffImage(res.bytes)
    if (!declared || !sniffed || declared !== sniffed)
      throw new Error('not an image')
    fetched = { bytes: res.bytes, mime: sniffed, url: res.url }
  } catch {
    // Deliberately the same for a guard refusal, a network failure, an HTTP
    // error, an oversized body and a disguised one.
    throw new ApiError(422, REMOTE_IMAGE_FAILURE)
  }

  return attachmentUpload(
    ctx,
    store,
    {
      doc: input.doc,
      filename: remoteImageName(input.url, fetched.mime),
      mime: fetched.mime,
    },
    fetched.bytes,
  )
}
