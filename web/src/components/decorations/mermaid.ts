/**
 * Diagram rendering, loaded only when a document actually contains one.
 *
 * Mermaid is the largest dependency in this application by a wide margin: it
 * carries a parser per diagram type, d3, and a layout engine. Putting it in
 * the main bundle would roughly triple it, for a feature most pages never use.
 * So it lives behind a dynamic import, the same pattern `highlight.ts` uses
 * for Shiki and `katex.ts` uses for KaTeX.
 */

type TMermaid = {
  initialize: (config: Record<string, unknown>) => void
  parse: (source: string) => Promise<unknown>
  render: (id: string, source: string) => Promise<{ svg: string }>
}

let mermaid: Promise<TMermaid> | null = null
let theme: string | null = null
let seq = 0

/** `dark` is the class `@nubisco/ui`'s theme controller puts on the root. */
function wantedTheme(): string {
  return typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'default'
}

async function load(): Promise<TMermaid> {
  mermaid ??= import('mermaid').then(
    (mod) => (mod.default ?? mod) as unknown as TMermaid,
  )
  const engine = await mermaid
  // Re-initialised when the page changes theme, so a diagram redrawn after a
  // theme switch is drawn in the theme the reader is now looking at.
  const want = wantedTheme()
  if (theme !== want) {
    engine.initialize({
      startOnLoad: false,
      // Diagram source is somebody's document, and a document is untrusted
      // input. `strict` keeps script and foreign HTML out of the SVG.
      securityLevel: 'strict',
      theme: want,
      fontFamily: 'inherit',
    })
    theme = want
  }
  return engine
}

/** A drawn diagram, or the reason it could not be drawn. */
export type TDiagramResult = { svg: string } | { error: string }

/**
 * One diagram.
 *
 * `parse` runs first because it is the call with a useful message on it:
 * Mermaid's parse errors name the line and the token, where a failure inside
 * `render` can surface as a layout exception that says nothing. Either way the
 * caller gets a string to show rather than an exception to survive.
 */
export async function renderDiagram(source: string): Promise<TDiagramResult> {
  if (!source.trim()) return { error: 'The diagram is empty.' }
  try {
    const engine = await load()
    await engine.parse(source)
    const { svg } = await engine.render(`acta-mermaid-${++seq}`, source)
    return { svg }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    return { error: text.trim() || 'The diagram could not be drawn.' }
  }
}
