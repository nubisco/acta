import { describe, expect, it } from 'vitest'
import { extractRefs } from '../src/markdown'

const actors = (body: string) =>
  extractRefs(body)
    .filter((r) => r.type === 'actor')
    .map((r) => r.target)

describe('bare mentions', () => {
  it('reads @handle as a mention', () => {
    expect(actors('@ivan could you review this draft?')).toEqual(['ivan'])
    expect(actors('over to you @daniela, thanks')).toEqual(['daniela'])
  })
  it('still reads the bracketed form, and does not double count it', () => {
    expect(actors('ping [[@ivan]] please')).toEqual(['ivan'])
  })
  it('is not fooled by an email address', () => {
    expect(actors('write to jose@nubisco.io about it')).toEqual([])
    expect(actors('someone@example.com')).toEqual([])
  })
  it('is not fooled by a domain or a URL', () => {
    expect(actors('see https://x.com/@ivanmar for the thread')).toEqual([])
    expect(actors('mail us @nubisco.io')).toEqual([])
  })
  it('leaves code alone', () => {
    expect(actors('use `@ivan` in the template')).toEqual([])
    expect(actors('```\n@ivan\n```')).toEqual([])
  })
  it('marks which form it found', () => {
    const [bare] = extractRefs('@ivan hello').filter((r) => r.type === 'actor')
    expect(bare.bare).toBe(true)
    const [bracketed] = extractRefs('[[@ivan]] hello').filter(
      (r) => r.type === 'actor',
    )
    expect(bracketed.bare).toBeUndefined()
  })
  it('finds several, and reports where each one is', () => {
    const found = extractRefs('@jose and @daniela').filter(
      (r) => r.type === 'actor',
    )
    expect(found.map((r) => r.target)).toEqual(['jose', 'daniela'])
    expect(found[0].offset).toBe(0)
    expect(found[1].offset).toBe(10)
  })
  it('does not invent a mention from an imported handle that is not ours', () => {
    // Resolution is the caller's job, but the shape still has to be read.
    expect(actors('@ivanmarjanovic said so')).toEqual(['ivanmarjanovic'])
  })
})
