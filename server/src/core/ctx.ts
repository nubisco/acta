import type { ISqlDriver } from '../db'

export interface IActorCtx {
  id: string
  kind: 'human' | 'agent' | 'system'
  handle: string
  role: 'admin' | 'member'
  onBehalfOf?: string
  scopes: string[]
  /**
   * Which credential proved this, as opposed to who it proved.
   *
   * A personal access token acts as its owner, so `kind` is 'human' for both
   * a browser session and a token pasted into a config file, and anything
   * that must not be reachable from a pasted header has to ask this instead.
   * Minting tokens is the case that matters: without it, a leaked token mints
   * its own replacement and revoking the original achieves nothing.
   */
  tokenKind?: 'session' | 'agent' | 'personal'
}

export interface ICtx {
  db: ISqlDriver
  workspaceId: string
  actor: IActorCtx
  /** Event id chain when a rule caused this mutation (loop guard depth 1). */
  causedBy?: string
}

export class ApiError extends Error {
  status: number
  current?: unknown

  constructor(status: number, message: string, current?: unknown) {
    super(message)
    this.status = status
    this.current = current
  }
}

export function now(): number {
  return Date.now()
}
