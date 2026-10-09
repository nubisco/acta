/**
 * `inline-size` and `block-size` are container-query features. Inside
 * `@media` the browser ignores the whole rule, so a layout written that way
 * never adapts. The goal page squeezed its card list into a 54px column on a
 * phone for exactly this reason (UX audit, 2026-10-09).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(vue|scss|css)$/.test(name) ? [path] : []
  })
}

describe('media queries', () => {
  it('never test a container feature', () => {
    const offenders = files(join(__dirname, '../src')).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${path}:${i + 1}` }))
        .filter(({ line }) =>
          /@media[^{]*\b(min|max)-(inline|block)-size\b/.test(line),
        )
        .map(({ at }) => at),
    )
    expect(offenders).toEqual([])
  })
})
