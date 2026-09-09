import type { Filter as NostrToolsFilter } from 'nostr-tools/filter'
import type { Event as NostrToolsEvent, EventTemplate as NostrToolsTemplate } from 'nostr-tools/pure'

/** Lowercase hex, 64 characters. Pubkeys and event ids are hex everywhere in this library. */
export type Hex = string

/** A relay URL, normalised: `wss://`, no trailing slash. */
export type RelayUrl = string

/** A signed Nostr event. `id` and `sig` are always present. */
export type NostrEvent = NostrToolsEvent

/** An unsigned event, ready for a `Signer`. `pubkey`, `id` and `sig` are added by signing. */
export type EventTemplate = NostrToolsTemplate

export type Filter = NostrToolsFilter

/**
 * The only way this library touches a key. Implement it over a local key, a NIP-07 extension
 * or a NIP-46 remote signer; every method is async so all three fit.
 */
export interface Signer {
  getPublicKey(): Promise<Hex>
  /** Fill in `pubkey`, `id` and `sig`. Must not mutate the template. */
  signEvent(template: EventTemplate): Promise<NostrEvent>
}
