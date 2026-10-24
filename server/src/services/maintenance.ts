/**
 * The data-safety half of the cron (LA-401), one call for both entrypoints:
 * the Workers scheduled handler and the Bun interval.
 *
 * Each part is logged and swallowed on failure, so one failing never stops
 * the others, and they share one statement budget so a tick stays inside
 * what D1 allows a single invocation.
 */

import type { ISqlDriver } from '../db'
import { now } from '../core/ctx'
import type { TEmailSender } from '../core/email'
import type { AttachmentStore } from './attachments'
import { retentionSweep, type IBudget } from './retention'
import { storageAlert } from './storageAlert'
import { pruneExpiredExports, runPendingExport } from './workspaceExport'
import { purgeDueWorkspaces } from './workspaceDeletion'

export interface IMaintenanceDeps {
  store: AttachmentStore
  send?: TEmailSender
  baseUrl?: string
  nowMs?: number
  /** Statements this tick may spend on deletes. */
  budget?: number
}

async function step(name: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (err) {
    console.error(`${name} failed`, err)
  }
}

export async function maintenanceTick(
  db: ISqlDriver,
  deps: IMaintenanceDeps,
): Promise<void> {
  const ts = deps.nowMs ?? now()
  const budget: IBudget = { left: deps.budget ?? 300 }
  // An export the request's deferred task did not finish (or never started).
  await step('workspace export', () =>
    runPendingExport(db, { ...deps, nowMs: ts }),
  )
  await step('export prune', () =>
    pruneExpiredExports(db, deps.store, budget, ts),
  )
  await step('workspace purge', () =>
    purgeDueWorkspaces(db, deps.store, budget, ts),
  )
  await step('retention', () => retentionSweep(db, { nowMs: ts, budget }))
  await step('storage alert', () => storageAlert(db, { nowMs: ts }))
}
