/**
 * Reconciliation report shared by both importers (mvp F11/F12). Every source
 * entity must end up either created, or skipped with a reason; anything else
 * is a silent drop and fails the run (non-zero exit).
 */

import { writeFileSync } from 'node:fs'

export interface ICountRow {
  source: number
  created: number
  skipped: number
  failed: number
}

export interface ISkipEntry {
  kind: string
  id: string
  reason: string
  /** How many source entities this entry covers (default 1). */
  n?: number
}

export interface IReportSection {
  name: string
  counts: Record<string, ICountRow>
  skips: ISkipEntry[]
  failures: ISkipEntry[]
  notes: string[]
}

export class ReportSection {
  constructor(public data: IReportSection) {}

  private row(kind: string): ICountRow {
    let row = this.data.counts[kind]
    if (!row) {
      row = { source: 0, created: 0, skipped: 0, failed: 0 }
      this.data.counts[kind] = row
    }
    return row
  }

  source(kind: string, n = 1): void {
    this.row(kind).source += n
  }

  created(kind: string, n = 1): void {
    this.row(kind).created += n
  }

  skipped(kind: string, id: string, reason: string, n = 1): void {
    this.row(kind).skipped += n
    this.data.skips.push({ kind, id, reason, n: n === 1 ? undefined : n })
  }

  failed(kind: string, id: string, reason: string): void {
    this.row(kind).failed += 1
    this.data.failures.push({ kind, id, reason })
  }

  note(text: string): void {
    this.data.notes.push(text)
  }
}

export class ImportReport {
  sections: IReportSection[] = []
  unresolved: string[] = []
  unknownMacros: string[] = []
  mappings: Record<string, unknown> = {}
  errors: string[] = []

  constructor(
    public tool: string,
    public dryRun: boolean,
  ) {}

  section(name: string): ReportSection {
    const existing = this.sections.find((s) => s.name === name)
    if (existing) return new ReportSection(existing)
    const data: IReportSection = {
      name,
      counts: {},
      skips: [],
      failures: [],
      notes: [],
    }
    this.sections.push(data)
    return new ReportSection(data)
  }

  /**
   * True when nothing was silently dropped and nothing failed. A silent drop
   * is a source count not covered by created + skipped; sub-entity kinds
   * that only ever record skips (e.g. unmapped assignees) stay balanced.
   */
  ok(): boolean {
    if (this.errors.length > 0) return false
    for (const section of this.sections) {
      for (const row of Object.values(section.counts)) {
        if (row.failed > 0) return false
        if (row.created + row.skipped < row.source) return false
      }
    }
    return true
  }

  print(): void {
    const mode = this.dryRun ? 'dry-run' : 'apply'
    console.log(`\n== ${this.tool} report (${mode}) ==`)
    for (const section of this.sections) {
      console.log(`\n${section.name}`)
      for (const [kind, row] of Object.entries(section.counts)) {
        const bad = row.failed > 0 || row.created + row.skipped < row.source
        console.log(
          `  ${kind}: ${row.source} source, ${row.created} ${
            this.dryRun ? 'planned' : 'created'
          }, ${row.skipped} skipped, ${row.failed} failed${bad ? '  <-- MISMATCH' : ''}`,
        )
      }
      for (const skip of section.skips)
        console.log(`  skipped ${skip.kind} ${skip.id}: ${skip.reason}`)
      for (const failure of section.failures)
        console.log(`  FAILED ${failure.kind} ${failure.id}: ${failure.reason}`)
      for (const note of section.notes) console.log(`  note: ${note}`)
    }
    if (this.unknownMacros.length > 0)
      console.log(`\nunknown macros: ${this.unknownMacros.join(', ')}`)
    if (this.unresolved.length > 0) {
      console.log('\nunresolved references:')
      for (const ref of this.unresolved) console.log(`  ${ref}`)
    }
    for (const error of this.errors) console.log(`\nERROR: ${error}`)
    console.log(`\nresult: ${this.ok() ? 'OK' : 'FAILED (see above)'}`)
  }

  write(path: string): void {
    writeFileSync(
      path,
      JSON.stringify(
        {
          tool: this.tool,
          dry_run: this.dryRun,
          ok: this.ok(),
          generated_at: new Date().toISOString(),
          sections: this.sections,
          unknown_macros: this.unknownMacros,
          unresolved: this.unresolved,
          errors: this.errors,
          mappings: this.mappings,
        },
        null,
        2,
      ),
    )
  }
}
