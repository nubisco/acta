/**
 * Async SQL driver interface with two implementations: bun:sqlite for
 * self-host/dev/tests and Cloudflare D1 for the hosted deployment. The
 * service layer only ever sees ISqlDriver.
 */

import {
  ADDITIVE_COLUMNS,
  FTS_COLUMN_RENAME,
  LINK_REBUILD,
  REINDEX_FTS,
  RENAMES,
  SCHEMA_SQL,
} from './schema'

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

/**
 * A rename that has already been applied fails with "no such table" or "no
 * such column", which means it is done rather than broken. Anything else is a
 * real fault and must not be swallowed, or a half-migrated database would
 * boot looking healthy.
 */
function renameAlreadyApplied(err: unknown): boolean {
  const text = String(err)
  return text.includes('no such table') || text.includes('no such column')
}

export function schemaStatements(): string[] {
  // Comments come out before the split, because the split is on `;` and a
  // comment is the one place a semicolon can appear without ending a
  // statement. Leaving them in meant an ordinary English sentence inside the
  // schema could cut a CREATE TABLE in half, and only on D1: bun:sqlite hands
  // the whole string to exec() and never splits, so every local test passed
  // while production failed to migrate.
  return SCHEMA_SQL.replace(/--[^\n]*/g, '')
    .split(';')
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
    // Before the schema, or CREATE IF NOT EXISTS would make an empty `space`
    // beside a `space` holding every row.
    for (const statement of RENAMES) {
      try {
        this.db.exec(statement)
      } catch (err) {
        if (!renameAlreadyApplied(err)) throw err
      }
    }
    this.rebuildLinkTable()
    this.renameFtsColumn()
    this.db.exec(SCHEMA_SQL)
    for (const statement of ADDITIVE_COLUMNS) {
      try {
        this.db.exec(statement)
      } catch (err) {
        if (!String(err).includes('duplicate column')) throw err
      }
    }
  }

  /** See LINK_REBUILD: a CHECK constraint cannot be altered in place. */
  private rebuildLinkTable(): void {
    let needed: boolean
    try {
      needed = this.db.query(LINK_REBUILD.detect).all().length > 0
    } catch {
      return // No link table yet; the schema below creates it correctly.
    }
    if (!needed) return
    for (const step of LINK_REBUILD.steps) this.db.exec(step)
  }

  /** FTS5 has no RENAME COLUMN, so the index is rebuilt from the rows. */
  private renameFtsColumn(): void {
    try {
      this.db.query(FTS_COLUMN_RENAME.detect).all()
      return // Already the new shape.
    } catch {
      // Falls through: either the old column, or no fts table at all.
    }
    try {
      this.db.exec(FTS_COLUMN_RENAME.drop)
      this.db.exec(FTS_COLUMN_RENAME.create)
      this.reindexFts()
    } catch {
      // No FTS5 in this build; search falls back to LIKE.
    }
  }

  private reindexFts(): void {
    for (const statement of REINDEX_FTS) this.db.exec(statement)
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
    // Before the schema, or CREATE IF NOT EXISTS would make an empty `space`
    // beside a `space` holding every row.
    for (const statement of RENAMES) {
      try {
        await this.db.prepare(statement).run()
      } catch (err) {
        if (!renameAlreadyApplied(err)) throw err
      }
    }
    await this.rebuildLinkTable()
    await this.renameFtsColumn()
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
    for (const statement of ADDITIVE_COLUMNS) {
      try {
        await this.db.prepare(statement).run()
      } catch (err) {
        if (!String(err).includes('duplicate column')) throw err
      }
    }
    this.migrated = true
  }

  /** See LINK_REBUILD: a CHECK constraint cannot be altered in place. */
  private async rebuildLinkTable(): Promise<void> {
    let needed: boolean
    try {
      const res = await this.db.prepare(LINK_REBUILD.detect).all()
      needed = (res.results?.length ?? 0) > 0
    } catch {
      return // No link table yet; the schema below creates it correctly.
    }
    if (!needed) return
    for (const step of LINK_REBUILD.steps) await this.db.prepare(step).run()
  }

  /** FTS5 has no RENAME COLUMN, so the index is rebuilt from the rows. */
  private async renameFtsColumn(): Promise<void> {
    try {
      await this.db.prepare(FTS_COLUMN_RENAME.detect).all()
      return // Already the new shape.
    } catch {
      // Falls through: either the old column, or no fts table at all.
    }
    try {
      await this.db.prepare(FTS_COLUMN_RENAME.drop).run()
      await this.db.prepare(FTS_COLUMN_RENAME.create).run()
      for (const statement of REINDEX_FTS) {
        await this.db.prepare(statement).run()
      }
    } catch {
      this.supportsFts = false
    }
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
