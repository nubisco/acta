/**
 * Callouts, as one vocabulary shared by the reader and the editor.
 *
 * These lived inside `MarkdownView` while the editor knew nothing about them,
 * which is why a callout survived an edit only as literal text. Both surfaces
 * read from here now, so a type added in one place appears in the other.
 */

/**
 * Callout keywords, and what each renders as.
 *
 * GitHub's set is NOTE, TIP, IMPORTANT, WARNING and CAUTION. Ours was INFO,
 * NOTE, TIP, WARNING and DANGER, so two of the five people actually type fell
 * through the renderer and appeared as the literal text "[!IMPORTANT]" in the
 * middle of a blockquote. Anyone pasting from a README hit it immediately.
 * Both spellings are accepted now, and the extra two map onto styles that
 * exist.
 */
export const CALLOUT_TYPES: Record<string, string> = {
  INFO: 'info',
  NOTE: 'note',
  TIP: 'tip',
  IMPORTANT: 'info',
  WARNING: 'warning',
  CAUTION: 'danger',
  DANGER: 'danger',
}

/**
 * The canonical keyword to write back for each style.
 *
 * Serializing has to pick one spelling, and it must be one the parser accepts
 * or a save would destroy the callout it just read. IMPORTANT and CAUTION are
 * deliberately absent: they are accepted on the way in and normalise to the
 * style they share on the way out.
 */
export const CALLOUT_KEYWORD: Record<string, string> = {
  info: 'INFO',
  note: 'NOTE',
  tip: 'TIP',
  warning: 'WARNING',
  danger: 'DANGER',
}

/** Every style a callout can take, for schema validation and pickers. */
export const CALLOUT_KINDS = Object.keys(CALLOUT_KEYWORD)

/* Phosphor regular glyphs, as path data.
 *
 * Stored as `d` rather than as markup so a node view can render a real
 * <path> element. Holding the markup meant the only way to draw it was
 * v-html, which is a rule worth never suppressing when the alternative is
 * this small. */
export const CALLOUT_ICON_PATHS: Record<string, string> = {
  info: 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z',
  note: 'M229.66,58.34l-32-32a8,8,0,0,0-11.32,0l-96,96A8,8,0,0,0,88,128v32a8,8,0,0,0,8,8h32a8,8,0,0,0,5.66-2.34l96-96A8,8,0,0,0,229.66,58.34ZM124.69,152H104V131.31l64-64L188.69,88ZM200,76.69,179.31,56,192,43.31,212.69,64ZM224,128v80a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32h80a8,8,0,0,1,0,16H48V208H208V128a8,8,0,0,1,16,0Z',
  tip: 'M176,232a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h80A8,8,0,0,1,176,232Zm40-128a87.55,87.55,0,0,1-33.64,69.21A16.24,16.24,0,0,0,176,186v6a16,16,0,0,1-16,16H96a16,16,0,0,1-16-16v-6a16,16,0,0,0-6.23-12.66A87.59,87.59,0,0,1,40,104.49C39.74,56.83,78.26,17.14,125.88,16A88,88,0,0,1,216,104Zm-16,0a72,72,0,0,0-73.74-72c-39,.92-70.47,33.39-70.26,72.39a71.65,71.65,0,0,0,27.64,56.3A32,32,0,0,1,96,186v6h64v-6a32.15,32.15,0,0,1,12.47-25.35A71.65,71.65,0,0,0,200,104Zm-16.11-9.34a57.6,57.6,0,0,0-46.56-46.55,8,8,0,0,0-2.66,15.78c16.57,2.79,30.63,16.85,33.44,33.45A8,8,0,0,0,176,104a9,9,0,0,0,1.35-.11A8,8,0,0,0,183.89,94.66Z',
  warning:
    'M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM222.93,203.8a8.5,8.5,0,0,1-7.48,4.2H40.55a8.5,8.5,0,0,1-7.48-4.2,7.59,7.59,0,0,1,0-7.72L120.52,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.93,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z',
  danger:
    'M120,136V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0ZM232,91.55v72.9a15.86,15.86,0,0,1-4.69,11.31l-51.55,51.55A15.86,15.86,0,0,1,164.45,232H91.55a15.86,15.86,0,0,1-11.31-4.69L28.69,175.76A15.86,15.86,0,0,1,24,164.45V91.55a15.86,15.86,0,0,1,4.69-11.31L80.24,28.69A15.86,15.86,0,0,1,91.55,24h72.9a15.86,15.86,0,0,1,11.31,4.69l51.55,51.55A15.86,15.86,0,0,1,232,91.55Zm-16,0L164.45,40H91.55L40,91.55v72.9L91.55,216h72.9L216,164.45ZM128,160a12,12,0,1,0,12,12A12,12,0,0,0,128,160Z',
}

/** The opening marker, as written in markdown: `[!NOTE]` with an optional title. */
export const CALLOUT_MARKER = /^\[!([A-Za-z]+)\]\s*(.*)$/

/**
 * Reads the first line of a blockquote as a callout marker.
 *
 * Returns null for an ordinary quotation, which is the common case and must
 * stay an ordinary quotation.
 */
export function parseCalloutMarker(
  firstLine: string,
): { kind: string; title: string } | null {
  const match = CALLOUT_MARKER.exec(firstLine.trim())
  if (!match) return null
  const kind = CALLOUT_TYPES[match[1].toUpperCase()]
  if (!kind) return null
  return { kind, title: match[2].trim() }
}

/** The icon markup for a style, as an inline SVG string. */
export function calloutIconSvg(
  kind: string,
  className = 'md__callout-icon',
): string {
  const d = CALLOUT_ICON_PATHS[kind] ?? CALLOUT_ICON_PATHS.info
  return `<svg class="${className}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`
}
