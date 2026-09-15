/**
 * Google Drive links, recognised from the URL alone.
 *
 * A Drive URL is self-describing: the path says what kind of file it is and
 * carries the file id. So the pill (right icon, right colour, opens in a new
 * tab) needs no Google account, no API call, no rate limit and no consent
 * screen, and it works for every reader including ones who have never
 * connected an account.
 *
 * The one thing the URL cannot give is the document's title. That needs
 * Drive's API, a per-viewer OAuth grant, and the `drive.metadata.readonly`
 * scope, which Google classes as restricted. Deliberately not done here.
 */

export type TDriveKind =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'form'
  | 'drawing'
  | 'file'
  | 'folder'

export interface IDriveLink {
  kind: TDriveKind
  /** Drive's own id for the file, kept for the metadata lookup phase two adds. */
  id: string
}

/** What each kind is called, for a reader who cannot see the icon. */
export const DRIVE_LABELS: Record<TDriveKind, string> = {
  document: 'Google Doc',
  spreadsheet: 'Google Sheet',
  presentation: 'Google Slides',
  form: 'Google Form',
  drawing: 'Google Drawing',
  file: 'Drive file',
  folder: 'Drive folder',
}

/**
 * Google's brand colours per app, which is the whole reason the pill is
 * readable at a glance: people recognise a Sheet by its green long before
 * they read the word.
 */
export const DRIVE_COLORS: Record<TDriveKind, string> = {
  document: '#1a73e8',
  spreadsheet: '#0f9d58',
  presentation: '#f4b400',
  form: '#7248b9',
  drawing: '#db4437',
  file: '#5f6368',
  folder: '#5f6368',
}

const EDITOR_KINDS: Record<string, TDriveKind> = {
  document: 'document',
  spreadsheets: 'spreadsheet',
  presentation: 'presentation',
  forms: 'form',
  drawings: 'drawing',
}

/**
 * Parse a Drive or Docs URL.
 *
 * Returns null for anything else, including other google.com URLs: a search
 * result or a Maps link is not a document and must stay an ordinary link.
 */
export function parseDriveUrl(href: string): IDriveLink | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)

  // docs.google.com/document/d/<id>, /spreadsheets/d/<id>, and friends.
  if (host === 'docs.google.com') {
    const kind = EDITOR_KINDS[parts[0] ?? '']
    // `/u/0/document/d/<id>` for people signed in to several accounts.
    const offset = parts[0] === 'u' ? 2 : 0
    const kindAt = EDITOR_KINDS[parts[offset] ?? '']
    const resolved = kind ?? kindAt
    if (!resolved) return null
    const dIndex = parts.indexOf('d', offset)
    const id = dIndex === -1 ? '' : (parts[dIndex + 1] ?? '')
    if (!id) return null
    return { kind: resolved, id }
  }

  if (host === 'drive.google.com') {
    // /file/d/<id>/view, /drive/folders/<id>, /open?id=<id>
    if (parts[0] === 'file' && parts[1] === 'd' && parts[2])
      return { kind: 'file', id: parts[2] }
    const folderAt = parts.indexOf('folders')
    if (folderAt !== -1 && parts[folderAt + 1])
      return { kind: 'folder', id: parts[folderAt + 1] }
    const open = url.searchParams.get('id')
    if (parts[0] === 'open' && open) return { kind: 'file', id: open }
    return null
  }

  return null
}
