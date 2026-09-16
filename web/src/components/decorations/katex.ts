/**
 * Formula rendering, loaded only when a document actually contains one.
 *
 * KaTeX is roughly a quarter of a megabyte of JavaScript before its stylesheet
 * and fonts, which is more than the whole of this application's vendor chunk
 * would thank us for. So nothing is imported until the first `$...$` or `$$`
 * appears on a page, exactly as `highlight.ts` does for Shiki.
 *
 * The stylesheet is imported from inside the same dynamic boundary. A static
 * `import 'katex/dist/katex.min.css'` would be hoisted into the main CSS file
 * and the fonts with it, which is the payload this file exists to avoid.
 */

type TKatex = {
  renderToString: (
    latex: string,
    options: { displayMode: boolean; throwOnError: boolean; strict: boolean },
  ) => string
}

let katex: Promise<TKatex> | null = null

async function load(): Promise<TKatex> {
  katex ??= (async () => {
    const [mod] = await Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ])
    return (mod.default ?? mod) as unknown as TKatex
  })()
  return katex
}

/** Rendered maths, or the reason it could not be rendered. */
export type TMathResult = { html: string } | { error: string }

/**
 * One formula.
 *
 * A syntax error comes back as a message rather than an exception. KaTeX's own
 * messages name the construct and the position, which is the difference
 * between "your formula has a typo" and a document that renders as a blank
 * rectangle, or worse throws and takes the page with it.
 */
export async function renderMath(
  latex: string,
  display: boolean,
): Promise<TMathResult> {
  try {
    const engine = await load()
    return {
      html: engine.renderToString(latex, {
        displayMode: display,
        throwOnError: true,
        // Unicode and other non-strict input warns rather than refusing. A
        // pasted formula with a stray character should still draw.
        strict: false,
      }),
    }
  } catch (err) {
    return { error: message(err) }
  }
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // KaTeX prefixes its own errors already. Anything else is the module
  // failing to arrive, which the reader should say plainly.
  return text.startsWith('KaTeX')
    ? text
    : `Formula could not be rendered: ${text}`
}
