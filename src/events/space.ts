import { parseAddress } from '../core/events'
import { encodeNaddr } from '../core/keys'
import { LIVE_EVENT_KIND, parseLiveEvent } from './live-event'
import { MEETING_KIND, isMeetingShaped, parseMeeting } from './meeting-event'
import { tryNormalizeRelayUrl } from '../core/relays'
import { ROOM_KIND, hashtagsOf, parseRoom, relaysOf, type RoomParticipant } from './room-event'
import type { Hex, NostrEvent, RelayUrl } from '../core/types'

/**
 * A SPACE — one thing a reader can join, whichever of three kinds announced it.
 *
 * The Spaces surfaces draw rooms (kind 30312), the meetings scheduled in them (30313) and live
 * streams (30311) in one list, and the three kinds disagree about everything: what the title
 * tag is called, what `status` may say, whether the host is the author or a p-tag, and whether
 * there is a page to open at all. This module is where those disagreements are settled, once,
 * against the real events every service publishes — so a card, a pill, a rail row and a push
 * reminder all read the same struct and cannot drift.
 *
 * ── Rules, each measured on 2026-09-08 and each a test ──────────────────────────────────
 *
 * FRESHNESS. `status: live` does not mean live. protocol rooms opened months ago still said so on
 * the relay, because nothing republishes an abandoned room. A room is live only while its
 * event is younger than `LIVE_FRESH_SECONDS`; a meeting, which the spec says to update while
 * running, gets one hour. Of 52 rooms saying live or open, three were fresh.
 *
 * THE HOST. A p-tag with the host role, else the author. (one service, which signed every room
 * with one platform key, had a rule of its own here; one service is dropped — see below.)
 *
 * THE PAGE. `service` is a web page for another service and another service, an API base for
 * a streaming service, and absent for the protocol, whose rooms are reachable at `the reference service/room/<naddr>`.
 * A pill that opens nothing is worse than no pill, so `joinUrl` is undefined rather than guessed
 * when no rule matches, and the card falls back to the resolver link it already had.
 *
 * AUDIO OR VIDEO. Rooms are audio by kind. A kind-30311 is a video stream unless it comes from
 * a host in `AUDIO_ROOM_HOSTS` — another service announces its audio rooms as streams.
 */

export type SpaceKind = typeof LIVE_EVENT_KIND | typeof ROOM_KIND | typeof MEETING_KIND

export const SPACE_KINDS: readonly SpaceKind[] = Object.freeze([ROOM_KIND, MEETING_KIND, LIVE_EVENT_KIND])

export function isSpaceKind(kind: number): kind is SpaceKind {
  return kind === ROOM_KIND || kind === MEETING_KIND || kind === LIVE_EVENT_KIND
}

/**
 * The three states a list can act on. No `unknown`: an event whose state cannot be read is
 * not listed at all (see `spaceFrom`), because every section is a claim about what is happening.
 */
export type SpaceStatus = 'live' | 'planned' | 'ended'

export type SpaceRole = 'host' | 'cohost' | 'moderator' | 'speaker' | 'listener'

export interface SpaceParticipant {
  pubkey: Hex
  role: SpaceRole
}

export interface SpaceService {
  /** `one service`, `the reference service`, `another service`, `another service`, `a streaming service` — or the bare hostname. */
  name: string
  /** The hostname the name was read from, when there was one. */
  host: string | undefined
  /** A page a browser can open. Undefined when no rule matched — never a transport URL. */
  joinUrl: string | undefined
}

export interface Space {
  kind: SpaceKind
  /** `kind:pubkey:d` — the identity the store dedupes on and presence points at. */
  address: string
  /** The `naddr`, with up to two relay hints, for our own deep link and for services that take one. */
  bech32: string
  /** The signing key. The host only when `host` says so. */
  pubkey: Hex
  identifier: string
  title: string
  summary: string | undefined
  image: string | undefined
  status: SpaceStatus
  audio: boolean
  startsAt: number | undefined
  endsAt: number | undefined
  /** The event's own timestamp: when the publisher last said anything about it. */
  updatedAt: number
  host: Hex | undefined
  participants: SpaceParticipant[]
  /** From the event's own count tags. Presence is merged by whoever holds the presence events. */
  listeners: number | undefined
  totalParticipants: number | undefined
  recording: string | undefined
  /** For a meeting, its room's address; the store uses it to borrow the room's page. */
  room: string | undefined
  service: SpaceService
  /**
   * The `streaming` tag as written: an HLS manifest for a video stream, a MoQ relay for a the protocol
   * room, a page for another service. What a PLAYER reads; never what a button opens.
   */
  stream: string | undefined
  /** A protocol room's token service, for a listener that speaks its transport. */
  auth: string | undefined
  relays: RelayUrl[]
  hashtags: string[]
}

/** A room or stream saying `live` is believed for this long after its last republish. */
export const LIVE_FRESH_SECONDS = 8 * 60 * 60

/** A meeting is republished while it runs (spec), so a silent one is over after an hour. */
export const MEETING_FRESH_SECONDS = 60 * 60

/**
 * A planned space whose start passed this long ago without going live is not coming.
 *
 * one service's calendar events sit at `planned` until somebody starts the meeting, and one that
 * never started would otherwise stay in the calendar for a week.
 */
export const PLANNED_GRACE_SECONDS = 2 * 60 * 60

/** Hosts whose kind-30311 events are audio rooms rather than video streams. */
export const AUDIO_ROOM_HOSTS: readonly string[] = Object.freeze([])

/**
 * Services a client chooses not to list — by hostname suffix, or by a hashtag their events
 * carry. Empty here: that is a product decision, not the protocol's. Fill it in your fork.
 */
const DROPPED_SERVICE_HOSTS: readonly string[] = Object.freeze([])
const DROPPED_HASHTAGS: readonly string[] = Object.freeze([])

function droppedHost(host: string | undefined): boolean {
  return host !== undefined && DROPPED_SERVICE_HOSTS.some(known => host === known || host.endsWith(`.${known}`))
}


/** Names for hosts, keyed by hostname suffix. Only our own here; a reader sees any other hostname as written. Add yours in your fork. */
const SERVICE_NAMES: readonly [suffix: string, name: string][] = Object.freeze([['nostrich.org', 'Nostrich']])

/** Up to this many relay hints ride in the naddr. Two, as `addresses.ts` follows. */
const MAX_HINTS = 2

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.hostname.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function endsWithHost(host: string | undefined, suffix: string): boolean {
  return host !== undefined && (host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * Whether a `service` URL is a page rather than an API base.
 *
 * a streaming service writes `https://streams.example/api/v1`, which a browser opens to a JSON error.
 * one service writes `https://honey.one-service.example/meet/Meshtadel`, which opens the room. The
 * difference is not in the spec, so it is read off the URL: an `api` host label or an `/api/`
 * path segment is not a page.
 */
function isPage(url: string | undefined): url is string {
  if (url === undefined) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (/^api([-.]|$)/.test(parsed.hostname)) return false
  if (/(^|\/)api(\/|$)/.test(parsed.pathname)) return false
  return true
}

function serviceName(host: string | undefined, client: string | undefined): string {
  for (const [suffix, name] of SERVICE_NAMES) {
    if (endsWithHost(host, suffix)) return name
  }
  return host ?? 'Nostr'
}

/**
 * `Host`, `host`, `Room Owner`, `Owner`, `admin`, `Co-host` — the values actually written.
 *
 * EGG-07's `admin` may promote, demote and remove, which is exactly what X calls a co-host, so
 * it reads as one; `moderator` stays its own word for the services that write it.
 */
export function normalizeRole(raw: string): SpaceRole {
  const role = raw.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (role === 'host' || role === 'roomowner' || role === 'owner') return 'host'
  if (role === 'cohost' || role === 'admin') return 'cohost'
  if (role === 'moderator') return 'moderator'
  if (role === 'speaker') return 'speaker'
  return 'listener'
}

function normalizeParticipants(raw: readonly RoomParticipant[]): SpaceParticipant[] {
  const seen = new Set<string>()
  const out: SpaceParticipant[] = []
  for (const participant of raw) {
    if (seen.has(participant.pubkey)) continue
    seen.add(participant.pubkey)
    out.push({ pubkey: participant.pubkey, role: normalizeRole(participant.role) })
  }
  return out
}

/**
 * A published audience, or nothing to say.
 *
 * A service that writes `current_participants 0` (another service did, the evening Spaces launched) is
 * describing an empty room, and the surfaces would draw it: "+0" on a strip pill, "0 listening"
 * on a card. That is the `0` the rules above say never to show — an empty room reads as a broken
 * count, and the service name says the same thing better. Nothing said and nobody there draw alike.
 */
function audience(count: number | undefined): number | undefined {
  return count === undefined || count <= 0 ? undefined : count
}

/** The host, by the rule above: a p-tag with the host role, else the author. */
function hostFor(participants: readonly SpaceParticipant[], author: Hex): Hex | undefined {
  const named = participants.find(participant => participant.role === 'host')
  return named !== undefined ? named.pubkey : author
}

/**
 * The state a list acts on, from what was written and how long ago.
 *
 * `undefined` means "do not list": a `private` room, or a status nobody can read. Both are
 * cases where any section would be a guess.
 */
export function spaceStatus(
  raw: string | undefined,
  timing: { starts: number | undefined; ends: number | undefined; updatedAt: number },
  now: number,
  freshSeconds: number,
): SpaceStatus | undefined {
  const { starts, ends, updatedAt } = timing
  const fresh = now - updatedAt <= freshSeconds
  switch (raw) {
    case 'closed':
    case 'ended':
      return 'ended'
    case 'private':
      return undefined
    case 'planned':
      if (starts === undefined) return fresh ? 'planned' : 'ended'
      return starts + PLANNED_GRACE_SECONDS > now ? 'planned' : 'ended'
    case 'open':
    case 'live':
    case 'active':
      if (ends !== undefined && ends < now) return 'ended'
      // A room announced ahead of time with `open` already written: not live until it starts.
      if (starts !== undefined && starts > now + 60) return 'planned'
      return fresh ? 'live' : 'ended'
    default:
      // No status. A future start is still a fact; anything else is a guess.
      return starts !== undefined && starts > now ? 'planned' : undefined
  }
}

function hints(relays: readonly string[]): RelayUrl[] {
  const out: RelayUrl[] = []
  for (const raw of relays) {
    const url = tryNormalizeRelayUrl(raw)
    if (url === undefined || out.includes(url)) continue
    out.push(url)
  }
  return out
}

function bech32Of(kind: SpaceKind, pubkey: Hex, identifier: string, relays: readonly RelayUrl[]): string {
  return encodeNaddr({ kind, pubkey, identifier, relays: relays.slice(0, MAX_HINTS) })
}

/** The page for a room: `service`, when it is a page rather than an API base. */
function roomJoinUrl(service: string | undefined): string | undefined {
  return isPage(service) ? service : undefined
}

/**
 * The page for a stream: `service` when it is a page. A manifest handed to a browser tab is a
 * download, not a stream, so an audio room announced as a stream opens its `streaming` page only
 * when its host is listed in `AUDIO_ROOM_HOSTS`.
 */
function streamJoinUrl(service: string | undefined, streaming: string | undefined): string | undefined {
  const streamHost = hostOf(streaming)
  if (streamHost !== undefined && AUDIO_ROOM_HOSTS.includes(streamHost) && isPage(streaming)) return streaming
  return isPage(service) ? service : undefined
}

/**
 * One event → one Space, or nothing.
 *
 * Nothing for: a kind this does not know, an addressable event with no `d`, a private room, a
 * status nobody can read, or a kind-30313 that is not a meeting. Every "nothing" is a deliberate
 * refusal to list a guess; the reasons are in the rules above.
 */
export function spaceFrom(event: NostrEvent, now: number): Space | undefined {
  const space = spaceFromKind(event, now)
  if (space === undefined) return undefined
  if (droppedHost(space.service.host) || droppedHost(hostOf(space.stream)) || space.hashtags.some(tag => DROPPED_HASHTAGS.includes(tag))) {
    return undefined
  }
  return space
}

function spaceFromKind(event: NostrEvent, now: number): Space | undefined {
  const pubkey = event.pubkey.toLowerCase() as Hex

  if (event.kind === ROOM_KIND) {
    const room = parseRoom(event)
    if (room.identifier === '') return undefined
    const status = spaceStatus(
      room.status,
      { starts: room.starts, ends: room.ends, updatedAt: event.created_at },
      now,
      LIVE_FRESH_SECONDS,
    )
    if (status === undefined) return undefined
    const relays = hints(room.relays)
    const bech32 = bech32Of(ROOM_KIND, pubkey, room.identifier, relays)
    const participants = normalizeParticipants(room.participants)
    const serviceHost = hostOf(room.service) ?? hostOf(room.streaming)
    return {
      kind: ROOM_KIND,
      address: `${ROOM_KIND}:${pubkey}:${room.identifier}`,
      bech32,
      pubkey,
      identifier: room.identifier,
      title: room.name ?? 'Live room',
      summary: room.summary,
      image: room.image,
      status,
      audio: true,
      startsAt: room.starts,
      endsAt: room.ends,
      updatedAt: event.created_at,
      host: hostFor(participants, pubkey),
      participants,
      listeners: undefined,
      totalParticipants: undefined,
      recording: room.recording,
      room: undefined,
      service: {
        name: serviceName(serviceHost, room.client),
        host: serviceHost,
        joinUrl: roomJoinUrl(room.service),
      },
      stream: room.streaming,
      auth: room.auth,
      relays,
      hashtags: room.hashtags,
    }
  }

  if (event.kind === MEETING_KIND) {
    if (!isMeetingShaped(event)) return undefined
    const meeting = parseMeeting(event)
    if (meeting.identifier === '') return undefined
    const status = spaceStatus(
      meeting.status,
      { starts: meeting.starts, ends: meeting.ends, updatedAt: event.created_at },
      now,
      MEETING_FRESH_SECONDS,
    )
    if (status === undefined) return undefined
    const relays = hints(meeting.relays)
    const bech32 = bech32Of(MEETING_KIND, pubkey, meeting.identifier, relays)
    const participants = normalizeParticipants(meeting.participants)
    // A meeting with no `service` has no page of its own; the store lends its room's, if any.
    const serviceHost = hostOf(meeting.service) ?? hostOf(meeting.streaming)
    return {
      kind: MEETING_KIND,
      address: `${MEETING_KIND}:${pubkey}:${meeting.identifier}`,
      bech32,
      pubkey,
      identifier: meeting.identifier,
      title: meeting.title ?? 'Scheduled room',
      summary: meeting.summary,
      image: meeting.image,
      status,
      audio: true,
      startsAt: meeting.starts,
      endsAt: meeting.ends,
      updatedAt: event.created_at,
      host: hostFor(participants, pubkey),
      participants,
      listeners: audience(meeting.currentParticipants),
      totalParticipants: meeting.totalParticipants,
      recording: undefined,
      room: meeting.room,
      stream: meeting.streaming,
      auth: undefined,
      service: {
        name: serviceName(serviceHost, undefined),
        host: serviceHost,
        joinUrl: isPage(meeting.service) ? meeting.service : undefined,
      },
      relays,
      hashtags: meeting.hashtags,
    }
  }

  if (event.kind === LIVE_EVENT_KIND) {
    const live = parseLiveEvent(event)
    if (live.identifier === '') return undefined
    const status = spaceStatus(
      live.status === 'unknown' ? undefined : live.status,
      { starts: live.starts, ends: live.ends, updatedAt: event.created_at },
      now,
      LIVE_FRESH_SECONDS,
    )
    if (status === undefined) return undefined
    const relays = hints(relaysOf(event))
    const bech32 = bech32Of(LIVE_EVENT_KIND, pubkey, live.identifier, relays)
    const participants = normalizeParticipants(parseRoom(event).participants)
    const service = firstValue(event, 'service')
    const serviceHost = hostOf(service) ?? hostOf(live.streaming)
    const streamHost = hostOf(live.streaming)
    return {
      kind: LIVE_EVENT_KIND,
      address: `${LIVE_EVENT_KIND}:${pubkey}:${live.identifier}`,
      bech32,
      pubkey,
      identifier: live.identifier,
      title: live.title ?? 'Live stream',
      summary: live.summary,
      image: live.image,
      status,
      audio: AUDIO_ROOM_HOSTS.includes(streamHost ?? '') || AUDIO_ROOM_HOSTS.includes(serviceHost ?? ''),
      startsAt: live.starts,
      endsAt: live.ends,
      updatedAt: event.created_at,
      // `parseLiveEvent` already applies the Host-p-tag-else-author rule; the platform rule
      // on top of it is the same one rooms get.
      host: hostFor(participants, live.host),
      participants,
      listeners: audience(live.currentParticipants),
      totalParticipants: live.totalParticipants,
      recording: live.recording,
      room: undefined,
      service: {
        name: serviceName(serviceHost, firstValue(event, 'client')),
        host: serviceHost,
        joinUrl: streamJoinUrl(service, live.streaming),
      },
      stream: live.streaming,
      auth: undefined,
      relays,
      hashtags: hashtagsOf(event),
    }
  }

  return undefined
}

function firstValue(event: NostrEvent, name: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] !== name) continue
    const value = tag[1]?.trim()
    return value === undefined || value === '' ? undefined : value
  }
  return undefined
}

/**
 * The moment a list sorts and dates a space by: its start while it runs or waits, its end
 * once it is over, and the event's own timestamp when the host wrote neither.
 */
export function spaceAt(space: Space): number {
  if (space.status === 'ended') return space.endsAt ?? space.startsAt ?? space.updatedAt
  return space.startsAt ?? space.updatedAt
}
