/**
 * Type-prefixed ULIDs (design-spec §1): `itm_01jf...` etc.
 * Lexicographically sortable by creation time; the first 10 chars of the
 * ULID encode unix milliseconds, so creation time is recoverable from the id.
 */

const ENCODING = '0123456789abcdefghjkmnpqrstvwxyz' // Crockford base32, lowercase
const TIME_LEN = 10
const RANDOM_LEN = 16

export const ID_PREFIXES = [
  'ws',
  'brd',
  'lst',
  'itm',
  'doc',
  'lbl',
  'lgr',
  'act',
  'cmt',
  'chk',
  'att',
  'whk',
  'rul',
  'evt',
] as const

export type TIdPrefix = (typeof ID_PREFIXES)[number]

function encodeTime(time: number): string {
  let out = ''
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[time % 32] + out
    time = Math.floor(time / 32)
  }
  return out
}

let lastTime = -1
let lastRandom: Uint8Array = new Uint8Array(RANDOM_LEN)

/**
 * Monotonic within the process: ids generated in the same millisecond
 * increment the random part, so id order always equals creation order
 * (activity cursors rely on this).
 */
export function ulid(time = Date.now()): string {
  if (time === lastTime) {
    for (let i = RANDOM_LEN - 1; i >= 0; i--) {
      lastRandom[i] = (lastRandom[i] + 1) % 32
      if (lastRandom[i] !== 0) break
    }
  } else {
    lastTime = time
    const bytes = new Uint8Array(RANDOM_LEN)
    crypto.getRandomValues(bytes)
    for (let i = 0; i < RANDOM_LEN; i++) bytes[i] %= 32
    lastRandom = bytes
  }
  return encodeTime(time) + encodeRandomDirect(lastRandom)
}

function encodeRandomDirect(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[bytes[i]]
  return out
}

export function newId(prefix: TIdPrefix, time?: number): string {
  return `${prefix}_${ulid(time)}`
}

const ID_RE = new RegExp(`^(${ID_PREFIXES.join('|')})_[0-9a-hjkmnp-tv-z]{26}$`)

export function isId(value: string, prefix?: TIdPrefix): boolean {
  if (!ID_RE.test(value)) return false
  return prefix ? value.startsWith(`${prefix}_`) : true
}

/** Recover the creation timestamp (unix ms) embedded in an id or bare ULID. */
export function idTime(id: string): number {
  const raw = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id
  let time = 0
  for (let i = 0; i < TIME_LEN; i++) {
    time = time * 32 + ENCODING.indexOf(raw[i])
  }
  return time
}
