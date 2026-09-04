/**
 * Thin driver over bun:sqlite. Kept behind an interface so a D1 driver can
 * slot in for the hosted variant without touching the service layer.
 */

import { Database } from 'bun:sqlite'
import schemaSql from './schema.sql' with { type: 'text' }

export interface ISqlDriver {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  run(sql: string, params?: unknown[]): void
  transaction<T>(fn: () => T): T
}

export class BunSqliteDriver implements ISqlDriver {
  private db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  migrate(): void {
    this.db.exec(schemaSql)
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.query(sql).all(...(params as never[])) as T[]
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.query(sql).run(...(params as never[]))
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close(): void {
    this.db.close()
  }
}

export function openDb(path: string): BunSqliteDriver {
  const driver = new BunSqliteDriver(path)
  driver.migrate()
  return driver
}
