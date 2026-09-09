import * as nip19 from 'nostr-tools/nip19'

import type { Hex, RelayUrl } from './types'

export class InvalidKeyError extends Error {}

/** Lowercase 64-hex or throw — the shape every pubkey has to be in before it reaches a filter. */
export function assertHexKey(value: string, what: string): Hex {
  const lower = value.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(lower)) throw new InvalidKeyError(`${what} is not a 64-character hex key`)
  return lower
}

export interface AddressPointer {
  kind: number
  pubkey: Hex
  identifier: string
  relays?: RelayUrl[]
}

/** `naddr1…` for an addressable event. */
export function encodeNaddr(pointer: AddressPointer): string {
  return nip19.naddrEncode({
    kind: pointer.kind,
    pubkey: assertHexKey(pointer.pubkey, 'pubkey'),
    identifier: pointer.identifier,
    ...(pointer.relays === undefined ? {} : { relays: pointer.relays }),
  })
}

export type Nip19Pointer =
  | { type: 'npub'; pubkey: Hex }
  | { type: 'nprofile'; pubkey: Hex; relays: RelayUrl[] }
  | { type: 'note'; id: Hex }
  | { type: 'nevent'; id: Hex; relays: RelayUrl[]; author?: Hex; kind?: number }
  | { type: 'naddr'; kind: number; pubkey: Hex; identifier: string; relays: RelayUrl[] }

/** Any bech32 pointer to hex. Throws on anything that is not one. */
export function decodePointer(value: string): Nip19Pointer {
  const decoded = nip19.decode(value.trim())
  switch (decoded.type) {
    case 'npub':
      return { type: 'npub', pubkey: decoded.data }
    case 'nprofile':
      return { type: 'nprofile', pubkey: decoded.data.pubkey, relays: decoded.data.relays ?? [] }
    case 'note':
      return { type: 'note', id: decoded.data }
    case 'nevent':
      return {
        type: 'nevent',
        id: decoded.data.id,
        relays: decoded.data.relays ?? [],
        ...(decoded.data.author === undefined ? {} : { author: decoded.data.author }),
        ...(decoded.data.kind === undefined ? {} : { kind: decoded.data.kind }),
      }
    case 'naddr':
      return {
        type: 'naddr',
        kind: decoded.data.kind,
        pubkey: decoded.data.pubkey,
        identifier: decoded.data.identifier,
        relays: decoded.data.relays ?? [],
      }
    default:
      throw new InvalidKeyError(`unsupported pointer: ${value}`)
  }
}

/** `npub1…` to hex. */
export function decodeNpub(npub: string): Hex {
  const pointer = decodePointer(npub)
  if (pointer.type !== 'npub') throw new InvalidKeyError('not an npub')
  return pointer.pubkey
}
