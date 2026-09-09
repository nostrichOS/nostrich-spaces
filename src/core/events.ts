/** Anything with a `tags` array: an event, a template, a parsed room. */
export interface Tagged {
  tags: string[][]
}

/** Every matching tag, copied so callers cannot mutate the event they were handed. */
export function getTags(source: Tagged, name: string): string[][] {
  const out: string[][] = []
  for (const tag of source.tags) {
    if (tag[0] === name) out.push([...tag])
  }
  return out
}

/** The second element of every matching tag. */
export function getTagValues(source: Tagged, name: string): string[] {
  const out: string[] = []
  for (const tag of source.tags) {
    if (tag[0] !== name) continue
    const value = tag[1]
    if (value !== undefined) out.push(value)
  }
  return out
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** Lowercase 64-hex, or undefined for anything else. */
export function normalizeHex(value: string): string | undefined {
  const lower = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(lower) ? lower : undefined
}

export interface ParsedAddress {
  kind: number
  pubkey: string
  identifier: string
}

/** `kind:pubkey:identifier`. Identifiers may contain `:`, so only the first two separators are structural. */
export function parseAddress(value: string): ParsedAddress | undefined {
  const firstColon = value.indexOf(':')
  if (firstColon < 1) return undefined
  const secondColon = value.indexOf(':', firstColon + 1)
  if (secondColon < 0) return undefined
  const kind = Number.parseInt(value.slice(0, firstColon), 10)
  const pubkey = normalizeHex(value.slice(firstColon + 1, secondColon))
  if (!Number.isInteger(kind) || kind < 0 || pubkey === undefined) return undefined
  return { kind, pubkey, identifier: value.slice(secondColon + 1) }
}

export interface BuildOptions {
  createdAt?: number
  /** Appended verbatim after the tags the builder generates. */
  tags?: string[][]
}
