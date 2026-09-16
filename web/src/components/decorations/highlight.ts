/**
 * Syntax highlighting, loaded only when a document actually contains code.
 *
 * Shiki carries a grammar per language and a full theme, which is far too
 * much to put in the initial bundle of an application whose main chunk is
 * already over a megabyte. So nothing is imported until the first code block
 * appears, and then only the languages on that page.
 *
 * Until a grammar arrives the block renders as plain text with its label and
 * copy button already working, which is the correct content either way. The
 * highlight is an enhancement arriving a frame later, not the thing that
 * makes the block readable.
 */
import type { HighlighterCore } from 'shiki/core'

/**
 * Languages we ship, by the names people write after the fence.
 *
 * An unlisted language renders plain rather than failing, so a document is
 * never broken by an exotic fence. Aliases matter: nobody writes `typescript`
 * when `ts` works.
 */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
  'c++': 'cpp',
  cs: 'csharp',
  postgres: 'sql',
  psql: 'sql',
}

const SUPPORTED = new Set([
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'vue',
  'html',
  'css',
  'scss',
  'shellscript',
  'yaml',
  'markdown',
  'python',
  'ruby',
  'rust',
  'go',
  'java',
  'cpp',
  'csharp',
  'php',
  'sql',
  'toml',
  'xml',
  'diff',
  'dockerfile',
])

/** The canonical name for what was written after the fence, or null. */
export function resolveLanguage(
  written: string | null | undefined,
): string | null {
  const name = (written ?? '').trim().toLowerCase()
  if (!name) return null
  const resolved = ALIASES[name] ?? name
  return SUPPORTED.has(resolved) ? resolved : null
}

let core: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()

/**
 * The shared highlighter, created once and grown as languages are needed.
 *
 * Both themes are loaded together so a theme switch does not need a second
 * fetch, and because Shiki can emit CSS variables for both at once, which is
 * what lets a highlighted block follow the page into dark mode without being
 * re-rendered.
 */
async function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ])
    return createHighlighterCore({
      themes: [
        import('shiki/themes/github-light-default.mjs'),
        import('shiki/themes/github-dark-default.mjs'),
      ],
      langs: [],
      // The JavaScript engine rather than the WASM one: no extra binary to
      // fetch, and the grammars here are ordinary ones it handles.
      engine: createJavaScriptRegexEngine(),
    })
  })()
  return core
}

/**
 * Highlighted HTML for one block, or null when the language is unknown.
 *
 * Returning null rather than throwing is deliberate: the caller already has
 * the plain rendering on screen and should keep it.
 */
export async function highlight(
  code: string,
  language: string,
): Promise<string | null> {
  const lang = resolveLanguage(language)
  if (!lang) return null
  try {
    const shiki = await highlighter()
    if (!loaded.has(lang)) {
      const grammar = await import(`shiki/langs/${lang}.mjs`)
      await shiki.loadLanguage(grammar.default ?? grammar)
      loaded.add(lang)
    }
    return shiki.codeToHtml(code, {
      lang,
      themes: { light: 'github-light-default', dark: 'github-dark-default' },
      defaultColor: false,
      cssVariablePrefix: '--nb-shiki-',
    })
  } catch {
    // A grammar that will not load is not worth failing a document over.
    return null
  }
}
