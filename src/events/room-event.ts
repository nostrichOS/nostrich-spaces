import { getTagValues, getTags } from '../core/events'
import type { Hex, NostrEvent } from '../core/types'

/**
 * NIP-53 INTERACTIVE ROOMS — kind 30312, the addressable event an audio space is.
 *
 * A room is the thing one service, the reference service and another service publish when somebody opens a space to talk
 * in. It carries where the room runs (`service`), whether it is open, and who is in it — and
 * every service writes those tags differently. Measured across 469 rooms on eight relays on
 * 2026-09-08: one service writes `status open|closed` and `service` as the room's own web page;
 * the protocol writes `status live|ended|planned`, no `service` at all, and a MoQ `streaming` URL; another service
 * writes `service` and a `Host` p-tag. None of them writes the `endpoint` tag the spec calls
 * optional, which is exactly why a client that requires it lists nothing.
 *
 * PARSING ONLY, like `live-event.ts` beside it. Nothing here fetches and nothing decides what a
 * card looks like. The vocabulary differences are kept RAW here — `status` is whatever was
 * written — and reconciled once, in `space.ts`, where the rule can be tested against the real
 * events of every service.
 */

/** NIP-53 interactive room. Addressable: `30312:pubkey:d`, republished as it changes. */
export const ROOM_KIND = 30312

/** One `p` tag, as written. The role is free text in practice; `space.ts` normalises it. */
export interface RoomParticipant {
  pubkey: Hex
  role: string
}

export interface RoomEvent {
  identifier: string
  /** `room` first — the spec's name for it — then `title`, which the protocol writes instead. */
  name: string | undefined
  summary: string | undefined
  image: string | undefined
  /** As written, lower-cased. `open`, `closed`, `private` per spec; `live`, `ended`, `planned` in the wild. */
  status: string | undefined
  /** Where the room runs. A web page for one service and another service; absent for the protocol. */
  service: string | undefined
  /** A transport URL. the protocol writes its MoQ relay here; not a page anyone can open. */
  streaming: string | undefined
  /** the protocol' token service for that relay — `auth` tag, `https://moq-auth.the reference service`. */
  auth: string | undefined
  recording: string | undefined
  /** Unix seconds, when the host wrote them. */
  starts: number | undefined
  ends: number | undefined
  participants: RoomParticipant[]
  /** Relay hints from the `relays` tag, as written. */
  relays: string[]
  hashtags: string[]
  /** The `client` tag's name, when present — `the reference service`, `another service`, `another client`. */
  client: string | undefined
}

function firstTag(event: NostrEvent, name: string): string | undefined {
  const value = getTagValues(event, name)[0]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** A timestamp tag. A zero is 1970 and means the tag was written empty. */
export function tagSeconds(event: NostrEvent, name: string): number | undefined {
  const raw = firstTag(event, name)
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Every `p` tag with a well-formed pubkey, in the order written.
 *
 * The role is the fourth element per NIP-53 (`["p", pubkey, relay, role]`). Kept as written
 * because the values in the wild are not a closed set — `Host`, `host`, `Room Owner`, `Owner`,
 * `admin` — and the mapping belongs with the rule that reads it.
 */
export function participantsOf(event: NostrEvent): RoomParticipant[] {
  const out: RoomParticipant[] = []
  for (const tag of getTags(event, 'p')) {
    const pubkey = tag[1]?.toLowerCase()
    if (pubkey === undefined || !/^[0-9a-f]{64}$/.test(pubkey)) continue
    out.push({ pubkey: pubkey as Hex, role: (tag[3] ?? '').trim() })
  }
  return out
}

/**
 * The `relays` tag is ONE tag with many values — `["relays", url, url, …]` — unlike the
 * one-value-per-tag shape everything else in the event uses.
 */
export function relaysOf(event: NostrEvent): string[] {
  const out: string[] = []
  for (const tag of getTags(event, 'relays')) {
    for (const value of tag.slice(1)) {
      const trimmed = value.trim()
      if (trimmed !== '') out.push(trimmed)
    }
  }
  return out
}

export function hashtagsOf(event: NostrEvent): string[] {
  const out: string[] = []
  for (const value of getTagValues(event, 't')) {
    const tag = value.trim().toLowerCase()
    if (tag !== '' && !out.includes(tag)) out.push(tag)
  }
  return out
}

export function isRoomEvent(event: NostrEvent): boolean {
  return event.kind === ROOM_KIND
}

export function parseRoom(event: NostrEvent): RoomEvent {
  return {
    identifier: firstTag(event, 'd') ?? '',
    name: firstTag(event, 'room') ?? firstTag(event, 'title'),
    summary: firstTag(event, 'summary'),
    image: firstTag(event, 'image'),
    status: firstTag(event, 'status')?.toLowerCase(),
    service: firstTag(event, 'service'),
    streaming: firstTag(event, 'streaming'),
    auth: firstTag(event, 'auth'),
    recording: firstTag(event, 'recording'),
    starts: tagSeconds(event, 'starts'),
    ends: tagSeconds(event, 'ends'),
    participants: participantsOf(event),
    relays: relaysOf(event),
    hashtags: hashtagsOf(event),
    client: firstTag(event, 'client'),
  }
}
