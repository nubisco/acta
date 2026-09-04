/**
 * Async SQL driver interface with two implementations: bun:sqlite for
 * self-host/dev/tests and Cloudflare D1 for the hosted deployment. The
 * service layer only ever sees ISqlDriver.
 */

import { SCHEMA_SQL } from './schema'

export interface ISqlDriver {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>
  run(sql: string, params?: unknown[]): Promise<void>
  /**
   * Atomic on bun:sqlite. D1 has no interactive transactions, so there it
   * degrades to sequential execution; idempotent op_ids keep retries safe.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  /** False when FTS5 is unavailable (search falls back to LIKE). */
  readonly supportsFts: boolean
}

export function schemaStatements(): string[] {
  return SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => `${s};`)
}

// ---------------------------------------------------------------------------
// bun:sqlite
// ---------------------------------------------------------------------------

export class BunSqliteDriver implements ISqlDriver {
  private db: import('bun:sqlite').Database
  readonly supportsFts = true
  /** Serializes transactions: deferred listeners (rules) must not nest BEGIN. */
  private lock: Promise<void> = Promise.resolve()

  private constructor(db: import('bun:sqlite').Database) {
    this.db = db
  }

  static async open(path: string): Promise<BunSqliteDriver> {
    const { Database } = await import('bun:sqlite')
    const db = new Database(path, { create: true, strict: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    const driver = new BunSqliteDriver(db)
    driver.migrate()
    return driver
  }

  migrate(): void {
    this.db.exec(SCHEMA_SQL)
  }

  query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return Promise.resolve(
      this.db.query(sql).all(...(params as never[])) as T[],
    )
  }

  run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.query(sql).run(...(params as never[]))
    return Promise.resolve()
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock
    let release!: () => void
    this.lock = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      this.db.exec('BEGIN')
      try {
        const result = await fn()
        this.db.exec('COMMIT')
        return result
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    } finally {
      release()
    }
  }

  close(): void {
    this.db.close()
  }
}

export function openDb(path: string): Promise<BunSqliteDriver> {
  return BunSqliteDriver.open(path)
}

// ---------------------------------------------------------------------------
// Cloudflare D1 (structural types; @cloudflare/workers-types would conflict
// with the bun globals used elsewhere in this package)
// ---------------------------------------------------------------------------

export interface ID1PreparedStatement {
  bind(...values: unknown[]): ID1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export interface ID1Database {
  prepare(sql: string): ID1PreparedStatement
}

export class D1Driver implements ISqlDriver {
  supportsFts = true
  private migrated = false

  constructor(private db: ID1Database) {}

  /** Idempotent, lazy: runs once per isolate. */
  async migrate(): Promise<void> {
    if (this.migrated) return
    for (const statement of schemaStatements()) {
      if (statement.startsWith('PRAGMA')) continue
      try {
        await this.db.prepare(statement).run()
      } catch (err) {
        if (statement.includes('VIRTUAL TABLE') && statement.includes('fts')) {
          this.supportsFts = false
          continue
        }
        throw err
      }
    }
    this.migrated = true
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const { results } = await this.db
      .prepare(sql)
      .bind(...params)
      .all<T>()
    return results
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    if (this.supportsFts === false && sql.includes(' fts ')) return
    await this.db
      .prepare(sql)
      .bind(...params)
      .run()
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }
}
