import { ref, type Ref } from 'vue'
import type { TViewState } from '@/types/api'
import { ApiHttpError } from '@/api/client'

/** Human wording for failures; raw exception text never reaches a user. */
export function humanise(err: unknown): string {
  if (err instanceof ApiHttpError) {
    if (err.status === 403) return 'You do not have access to this'
    if (err.status === 404) return 'That no longer exists'
    if (err.status === 409) return 'Someone else changed this in the meantime'
    if (err.status >= 500) return 'The server had a problem; try again'
    return 'The request could not be completed'
  }
  if (err instanceof TypeError) return 'Could not reach the server'
  return 'Something went wrong; try again'
}

export interface ILoadState {
  state: Ref<TViewState>
  message: Ref<string>
  run<T>(work: Promise<T>): Promise<T | null>
}

/**
 * The empty-states pattern's precedence machine: loading, error, forbidden,
 * ready. `no-results` vs `empty` is the view's own decision once ready.
 */
export function useLoadState(): ILoadState {
  const state = ref<TViewState>('loading')
  const message = ref('')
  async function run<T>(work: Promise<T>): Promise<T | null> {
    state.value = 'loading'
    try {
      const result = await work
      state.value = 'ready'
      return result
    } catch (err) {
      state.value =
        err instanceof ApiHttpError && err.status === 403
          ? 'forbidden'
          : 'error'
      message.value = humanise(err)
      return null
    }
  }
  return { state, message, run }
}

export function relativeTime(ts: number): string {
  const diffMs = ts - Date.now()
  const minutes = Math.round(diffMs / 60_000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return formatter.format(days, 'day')
  return new Date(ts).toLocaleDateString()
}
