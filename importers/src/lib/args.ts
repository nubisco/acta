/**
 * Minimal argv parser for the importer CLIs. Flags collect every value up to
 * the next flag (`--files a.json b.json`); a flag without values is boolean.
 */

export interface IParsedArgs {
  flags: Map<string, string[]>
  positional: string[]
}

export function parseArgs(argv: string[]): IParsedArgs {
  const flags = new Map<string, string[]>()
  const positional: string[] = []
  let current: string[] | null = null
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      current = flags.get(name) ?? []
      flags.set(name, current)
    } else if (current) {
      current.push(arg)
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

export function flagValues(args: IParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? []
}

export function flagValue(args: IParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.[0]
}

export function hasFlag(args: IParsedArgs, name: string): boolean {
  return args.flags.has(name)
}
