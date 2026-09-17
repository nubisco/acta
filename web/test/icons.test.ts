/**
 * Runtime-named icons must be registered.
 *
 * The bundler plugin links an icon only when its name is a literal in a
 * template. A name taken from data (a menu built from a list) resolves at
 * runtime against what `registerActaIcons` registered, and an unregistered one
 * throws while rendering, which empties the whole menu. The test environment
 * loads the full catalogue, so a mounted component cannot catch this. This
 * checks the registry itself instead.
 *
 * Found in a real browser: the block grip's "Turn into" choices rendered
 * nothing, because `text-h-one` and eight others were never registered.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLOCK_TARGETS } from '@/components/editor/blockOps'
import { slashItems } from '@/components/editor/suggestions'

const source = readFileSync(resolve(__dirname, '../src/lib/icons.ts'), 'utf8')
const call = source.slice(source.indexOf('registerIcons({'))

/** The names passed to registerIcons, quoted keys and shorthand alike. */
const registered = new Set(
  Array.from(call.matchAll(/^\s+(?:'([^']+)'|(\w+))\s*[:,]/gm)).map(
    (m) => m[1] ?? m[2],
  ),
)

describe('registerActaIcons', () => {
  it('covers every "Turn into" choice in the block grip menu', () => {
    const missing = BLOCK_TARGETS.map((t) => t.icon).filter(
      (name) => !registered.has(name),
    )
    expect(missing).toEqual([])
  })

  it('covers every entry of the + and / insert menus', () => {
    const missing = slashItems('')
      .map((item) => item.icon)
      .filter((name) => !registered.has(name))
    expect(missing).toEqual([])
  })
})

/**
 * Literal icon names must exist in the library.
 *
 * A literal in a template is linked at build time, so it needs no
 * registration, but a name the library does not ship still throws while
 * rendering. Found on Home: the "See everything happening in this workspace"
 * button asked for `activity`, which @nubisco/ui has never had, so the button
 * failed to render. Checked against the icons the installed library actually
 * ships, so a misspelling or a removed icon fails here instead of in front of
 * somebody.
 */
describe('literal icon names', () => {
  const libraryIcons = new Set(
    readdirSync(
      resolve(
        realpathSync(resolve(__dirname, '../node_modules/@nubisco/ui')),
        'dist/icons',
      ),
    ).map((file) => file.replace(/\.(d\.ts|mjs|cjs|js)$/, '')),
  )

  const literals = new Map<string, string[]>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.vue'))
        for (const match of readFileSync(path, 'utf8').matchAll(
          /(?<![:\w-])icon="([a-z0-9-]+)"/g,
        ))
          literals.set(match[1], [
            ...(literals.get(match[1]) ?? []),
            path.slice(path.indexOf('/src/') + 1),
          ])
    }
  }
  walk(resolve(__dirname, '../src'))

  it('finds the library icons and the template names to check', () => {
    expect(libraryIcons.size).toBeGreaterThan(100)
    expect(literals.size).toBeGreaterThan(10)
  })

  it('uses only icons the library ships', () => {
    const missing = [...literals]
      .filter(([name]) => !libraryIcons.has(name))
      .map(([name, files]) => `${name} in ${[...new Set(files)].join(', ')}`)
    expect(missing).toEqual([])
  })
})
