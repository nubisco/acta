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
import { readFileSync } from 'node:fs'
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
