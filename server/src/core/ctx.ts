import type { ISqlDriver } from '../db'

export interface IActorCtx {
  id: string
  kind: 'human' | 'agent' | 'system'
  handle: string
  role: 'admin' | 'member'
  onBehalfOf?: string
  scopes: string[]
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
