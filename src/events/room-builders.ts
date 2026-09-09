import { nowSeconds, type BuildOptions } from '../core/events'
import { PRESENCE_KIND } from './presence-event'
import { ROOM_KIND } from './room-event'
import type { EventTemplate, Hex, RelayUrl } from '../core/types'

/**
 * THE EVENTS A NOSTRICH-HOSTED SPACE WRITES — kind 30312 (the room), 10312 (presence), 4312 (a
 * moderation command) and 7 (a reaction aimed at the room).
 *
 * Shapes follow the audio-room protocol as another client specifies it (EGG-01, -04, -06, -07 in its
 * `wireClient/specs`), because that is the one audio-room protocol two other clients speak:
 * another client joins and speaks in such a room natively, the reference service's web client does too, and
 * every other client lists the room and links to its `service` page. Where the EGG vocabulary and
 * the older NIP-53 vocabulary differ, BOTH are written (`title` and `room`) so a reader of either
 * generation sees a name; where they conflict (`status live` vs `open`), the EGG value is written
 * and the older one is left to readers that already accept both, as `space.ts` does.
 *
 * Builders only. Nothing here signs, publishes, or decides when to publish; `room-session.ts`
 * in the web app does that, on top of a `Signer`.
 */

/** EGG-07: a moderation command. Ephemeral — relays drop it and readers forget it after 60 s. */
export const ADMIN_COMMAND_KIND = 4312

/**
 * EGG-04: presence carries a FIXED `d`, so one event is a person's current room across clients.
 * Kind 10312 is replaceable and needs no `d`; the tag is written because the reference readers
 * look for it.
 */
export const PRESENCE_IDENTIFIER = 'nests-room-presence'

/**
 * EGG-01 rule 9: the identifier is interpolated unescaped into the relay namespace
 * `nests/30312:<host>:<d>`, so it may contain nothing a URL path or a JWT claim would mangle.
 */
export const ROOM_IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export type RoomStatus = 'live' | 'planned' | 'ended'

export interface RoomInput {
  /** Must match `ROOM_IDENTIFIER_PATTERN`; `newRoomIdentifier()` makes one. */
  identifier: string
  title: string
  summary?: string
  image?: string
  status: RoomStatus
  /** The MoQ relay's base URL (`streaming`), e.g. `https://moq.nostrich.org:4443`. */
  streaming: string
  /** The token service's base URL (`auth`), without `/auth`. */
  auth: string
  /** The page a browser opens (`service`) — ours, so a listing in any client lands here. */
  service: string
  /** Where the room's chat and presence live; ONE `relays` tag, many values. */
  relays: readonly RelayUrl[]
  host: Hex
  /** EGG-07 `admin`: may promote, demote and remove; what X calls a co-host. */
  admins?: readonly Hex[]
  speakers?: readonly Hex[]
  hashtags?: readonly string[]
  startsAt?: number
  endsAt?: number
}

const HEX = '0123456789abcdef'

/** Sixteen random hex characters — well inside the identifier charset and long enough to never collide. */
export function newRoomIdentifier(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!
  return out
}

/** `nests/<kind>:<host>:<d>` — the relay namespace a token is minted for (EGG-02). */
export function roomNamespace(address: string): string {
  return `nests/${address}`
}

function clean(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim().replace(/\s+/g, ' ')
  if (trimmed === undefined || trimmed === '') return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function lowerHex(value: Hex): Hex {
  return value.toLowerCase() as Hex
}

/**
 * The room event. The host is the first `p` tag; a pubkey named in more than one role keeps the
 * highest one (host > admin > speaker), so promoting a speaker to co-host never leaves a second
 * tag behind for a reader to trip on.
 */
export function buildRoom(input: RoomInput, options: BuildOptions = {}): EventTemplate {
  if (!ROOM_IDENTIFIER_PATTERN.test(input.identifier)) {
    throw new Error(`room identifier must match ${ROOM_IDENTIFIER_PATTERN}: ${input.identifier}`)
  }
  const title = clean(input.title, 120) ?? 'Space'
  const hint = input.relays[0]
  const tags: string[][] = [
    ['d', input.identifier],
    ['title', title],
    ['room', title],
  ]
  const summary = clean(input.summary, 500)
  if (summary !== undefined) tags.push(['summary', summary])
  const image = clean(input.image, 2048)
  if (image !== undefined) tags.push(['image', image])
  tags.push(['status', input.status], ['streaming', input.streaming], ['auth', input.auth], ['service', input.service])
  if (input.relays.length > 0) tags.push(['relays', ...input.relays])

  const host = lowerHex(input.host)
  const roles = new Map<Hex, 'host' | 'admin' | 'speaker'>()
  roles.set(host, 'host')
  for (const admin of input.admins ?? []) {
    const key = lowerHex(admin)
    if (!roles.has(key)) roles.set(key, 'admin')
  }
  for (const speaker of input.speakers ?? []) {
    const key = lowerHex(speaker)
    if (!roles.has(key)) roles.set(key, 'speaker')
  }
  for (const [pubkey, role] of roles) tags.push(['p', pubkey, hint ?? '', role])

  const seen = new Set<string>()
  for (const raw of input.hashtags ?? []) {
    const tag = raw.trim().replace(/^#/, '').toLowerCase()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    tags.push(['t', tag])
  }
  if (input.startsAt !== undefined) tags.push(['starts', String(Math.floor(input.startsAt))])
  if (input.endsAt !== undefined) tags.push(['ends', String(Math.floor(input.endsAt))])
  tags.push(['alt', `${title} — a live audio Space`])
  return {
    kind: ROOM_KIND,
    content: '',
    tags: options.tags === undefined ? tags : [...tags, ...options.tags],
    created_at: options.createdAt ?? nowSeconds(),
  }
}

/** EGG-04: every flag, every time — a reader may assume an omitted flag is `0`, an emitter may not omit. */
export interface PresenceFlags {
  /** Request to speak. */
  hand: boolean
  /** Meaningful only while publishing; written regardless, per the spec. */
  muted: boolean
  /** An open audio broadcast on the relay right now. */
  publishing: boolean
  /** Holds a speaker slot in the room's p-tags and has not stepped off. */
  onstage: boolean
}

export const PRESENCE_OFF: PresenceFlags = Object.freeze({ hand: false, muted: false, publishing: false, onstage: false })

const bit = (value: boolean): string => (value ? '1' : '0')

/** The heartbeat. `address` is the room's `30312:host:d`; the hint is where the room's events live. */
export function buildPresence(
  address: string,
  flags: PresenceFlags,
  options: { relay?: RelayUrl } & BuildOptions = {},
): EventTemplate {
  const tags: string[][] = [
    ['d', PRESENCE_IDENTIFIER],
    options.relay === undefined ? ['a', address] : ['a', address, options.relay],
    ['hand', bit(flags.hand)],
    ['muted', bit(flags.muted)],
    ['publishing', bit(flags.publishing)],
    ['onstage', bit(flags.onstage)],
    ['alt', 'Room Presence tag'],
  ]
  return {
    kind: PRESENCE_KIND,
    content: '',
    tags: options.tags === undefined ? tags : [...tags, ...options.tags],
    created_at: options.createdAt ?? nowSeconds(),
  }
}

export type AdminAction = 'kick' | 'mute'

/**
 * EGG-07: a host or admin telling one peer to leave (`kick`) or to stop publishing (`mute`).
 * Authorisation is the signature: readers act only when the signer holds the role in the room's
 * latest event at the time the command arrives.
 */
export function buildAdminCommand(
  address: string,
  target: Hex,
  action: AdminAction,
  options: { relay?: RelayUrl } & BuildOptions = {},
): EventTemplate {
  const tags: string[][] = [
    options.relay === undefined ? ['a', address] : ['a', address, options.relay],
    ['p', lowerHex(target)],
    ['action', action],
    ['alt', 'Audio room admin command'],
  ]
  return {
    kind: ADMIN_COMMAND_KIND,
    content: '',
    tags: options.tags === undefined ? tags : [...tags, ...options.tags],
    created_at: options.createdAt ?? nowSeconds(),
  }
}

/**
 * EGG-06: a floating reaction over the room — a plain kind 7 whose `a` is the room, with an
 * optional `p` when it is aimed at one speaker. `k` names the room's kind the way every other
 * reaction here does. Custom emoji ride NIP-30.
 */
export function buildRoomReaction(
  address: string,
  content: string,
  options: { target?: Hex; relay?: RelayUrl; emoji?: { shortcode: string; url: string } } & BuildOptions = {},
): EventTemplate {
  const tags: string[][] = [
    options.relay === undefined ? ['a', address] : ['a', address, options.relay],
    ['k', String(ROOM_KIND)],
  ]
  if (options.target !== undefined) tags.push(['p', lowerHex(options.target)])
  let body = content
  if (options.emoji !== undefined) {
    body = `:${options.emoji.shortcode}:`
    tags.push(['emoji', options.emoji.shortcode, options.emoji.url])
  }
  return {
    kind: 7,
    content: body,
    tags: options.tags === undefined ? tags : [...tags, ...options.tags],
    created_at: options.createdAt ?? nowSeconds(),
  }
}
