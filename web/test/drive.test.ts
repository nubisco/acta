/**
 * Google Drive links.
 *
 * The parser is where this feature is right or wrong: a pill that appears on
 * a Maps link, or a Drive link that silently stays a raw URL, are both worse
 * than not having the feature.
 */
import { describe, expect, it } from 'vitest'
import { parseDriveUrl, DRIVE_LABELS } from '@/lib/drive'

describe('parseDriveUrl', () => {
  it('reads the kind and the id straight off the URL', () => {
    const cases: [string, string, string][] = [
      [
        'https://docs.google.com/document/d/1AbC_-123/edit',
        'document',
        '1AbC_-123',
      ],
      [
        'https://docs.google.com/spreadsheets/d/1Sheet99/edit#gid=0',
        'spreadsheet',
        '1Sheet99',
      ],
      [
        'https://docs.google.com/presentation/d/1Deck/edit?usp=sharing',
        'presentation',
        '1Deck',
      ],
      ['https://docs.google.com/forms/d/1Form/viewform', 'form', '1Form'],
      ['https://drive.google.com/file/d/1File/view', 'file', '1File'],
      ['https://drive.google.com/drive/folders/1Folder', 'folder', '1Folder'],
      ['https://drive.google.com/open?id=1Open', 'file', '1Open'],
    ]
    for (const [url, kind, id] of cases) {
      const parsed = parseDriveUrl(url)
      expect(parsed, url).not.toBeNull()
      expect(parsed!.kind, url).toBe(kind as never)
      expect(parsed!.id, url).toBe(id)
    }
  })

  it('handles the multi-account /u/0/ prefix', () => {
    // Anyone signed in to more than one Google account copies URLs in this
    // shape by default, so missing it would mean the feature quietly fails
    // for exactly the people most likely to use it.
    const parsed = parseDriveUrl(
      'https://docs.google.com/u/0/document/d/1Multi/edit',
    )
    expect(parsed).toEqual({ kind: 'document', id: '1Multi' })
  })

  it('leaves everything else alone', () => {
    const others = [
      'https://www.google.com/search?q=docs',
      'https://maps.google.com/maps?q=lisbon',
      'https://mail.google.com/mail/u/0/#inbox',
      'https://github.com/nubisco/acta/pull/1',
      'https://docs.google.com/',
      'https://docs.google.com/document/',
      'not a url at all',
      // A lookalike host is not Google. Matching on a suffix rather than the
      // whole hostname is how a phishing link gets a trustworthy pill.
      'https://docs.google.com.evil.test/document/d/1Bad/edit',
      'https://notdrive.google.com/file/d/1Bad/view',
    ]
    for (const url of others) expect(parseDriveUrl(url), url).toBeNull()
  })

  it('names every kind it can return', () => {
    // A kind with no label would render an empty pill.
    const kinds = [
      'document',
      'spreadsheet',
      'presentation',
      'form',
      'drawing',
      'file',
      'folder',
    ] as const
    for (const kind of kinds) expect(DRIVE_LABELS[kind]).toBeTruthy()
  })
})
