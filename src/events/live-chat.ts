import { getTagValues, getTags, nowSeconds } from '../core/events'
import type { EventTemplate, Hex, NostrEvent, RelayUrl } from '../core/types'

/**
 * NIP-53 LIVE CHAT — kind 1311, one message in a room's or a stream's chat.
 *
 * The chat beside a live thing is its own kind rather than a kind-1 reply, so a room's chatter
 * never lands in anybody's timeline. Every message names the activity through an \`a\` tag, and
 * that tag is the whole thread: there is no root note, only the address.
 */

export const LIVE_CHAT_KIND = 1311

export interface LiveChatMessage {
  id: Hex
  pubkey: Hex
  content: string
  createdAt: number
  /** The activity's address, \`kind:pubkey:d\`. */
  address: string
  /** The message this one answers, when the writer marked one. */
  replyTo: Hex | undefined
}

/** The message, or nothing when it names no activity — a chat line with no room is not chat. */
export function parseLiveChat(event: NostrEvent): LiveChatMessage | undefined {
  if (event.kind !== LIVE_CHAT_KIND) return undefined
  const address = getTagValues(event, 'a')[0]?.trim()
  if (address === undefined || !/^\d+:[0-9a-f]{64}:/.test(address)) return undefined
  let replyTo: Hex | undefined
  for (const tag of getTags(event, 'e')) {
    const id = tag[1]?.toLowerCase()
    if (id !== undefined && /^[0-9a-f]{64}$/.test(id)) replyTo = id as Hex
  }
  return {
    id: event.id as Hex,
    pubkey: event.pubkey.toLowerCase() as Hex,
    content: event.content,
    createdAt: event.created_at,
    address,
    replyTo,
  }
}

/**
 * A message to sign. The relay hint on the \`a\` tag is where the activity itself lives, so a
 * client that reads the message can find the room it is about.
 */
export function buildLiveChatMessage(
  address: string,
  content: string,
  options: { relay?: RelayUrl; replyTo?: Hex; createdAt?: number; tags?: readonly string[][] } = {},
): EventTemplate {
  const tags: string[][] = [options.relay === undefined ? ['a', address] : ['a', address, options.relay]]
  if (options.replyTo !== undefined) tags.push(['e', options.replyTo])
  // The composer's own tags — mentions, hashtags, imeta for a picture — ride along verbatim.
  for (const tag of options.tags ?? []) tags.push([...tag])
  return {
    kind: LIVE_CHAT_KIND,
    content,
    tags,
    created_at: options.createdAt ?? nowSeconds(),
  }
}
