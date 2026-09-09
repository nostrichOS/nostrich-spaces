import { getTagValues } from '../core/events'
import { hashtagsOf, participantsOf, relaysOf, tagSeconds, type RoomParticipant } from './room-event'
import type { NostrEvent } from '../core/types'

/**
 * NIP-53 ROOM MEETINGS — kind 30313, one scheduled or running session inside a room.
 *
 * A room (kind 30312) is the venue; a meeting is the appointment in it. one service's calendar is
 * made of these — "Monthly call, Saturday 10:00" pointing at the Meshtadel room through an `a`
 * tag — and they are what a "Get these in your calendar" list is built from. The spec makes
 * `a`, `title`, `starts` and `status` mandatory.
 *
 * The kind is also used for things that are not meetings at all: measured on 2026-09-08, a
 * price-oracle publisher was writing kind-30313 events with `oracle`, `chain` and `prices_hash`
 * tags and no `a`, no `title`. `isMeetingShaped` is the gate that keeps those out of a calendar.
 */

/** NIP-53 room meeting. Addressable: `30313:pubkey:d`. */
export const MEETING_KIND = 30313

export interface MeetingEvent {
  identifier: string
  /** The parent room's address — `30312:pubkey:d` — from the `a` tag. */
  room: string | undefined
  title: string | undefined
  summary: string | undefined
  image: string | undefined
  /** As written, lower-cased. `planned`, `live`, `ended` per spec; `active` seen once. */
  status: string | undefined
  service: string | undefined
  streaming: string | undefined
  starts: number | undefined
  ends: number | undefined
  currentParticipants: number | undefined
  totalParticipants: number | undefined
  participants: RoomParticipant[]
  relays: string[]
  hashtags: string[]
}

function firstTag(event: NostrEvent, name: string): string | undefined {
  const value = getTagValues(event, name)[0]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** A count tag. Dropped rather than coerced when it is not a clean integer — see `live-event.ts`. */
function count(event: NostrEvent, name: string): number | undefined {
  const raw = firstTag(event, name)
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) ? value : undefined
}

export function isMeetingEvent(event: NostrEvent): boolean {
  return event.kind === MEETING_KIND
}

/**
 * Whether a kind-30313 is a meeting at all, rather than something else wearing the number.
 *
 * A meeting has a title or names its room. The oracle events have neither, and a calendar row
 * with no title, no room and no start is not a row anybody can act on.
 */
export function isMeetingShaped(event: NostrEvent): boolean {
  if (event.kind !== MEETING_KIND) return false
  return firstTag(event, 'title') !== undefined || firstTag(event, 'a') !== undefined
}

export function parseMeeting(event: NostrEvent): MeetingEvent {
  return {
    identifier: firstTag(event, 'd') ?? '',
    room: firstTag(event, 'a'),
    title: firstTag(event, 'title'),
    summary: firstTag(event, 'summary'),
    image: firstTag(event, 'image'),
    status: firstTag(event, 'status')?.toLowerCase(),
    service: firstTag(event, 'service'),
    streaming: firstTag(event, 'streaming'),
    starts: tagSeconds(event, 'starts'),
    ends: tagSeconds(event, 'ends'),
    currentParticipants: count(event, 'current_participants'),
    totalParticipants: count(event, 'total_participants'),
    participants: participantsOf(event),
    relays: relaysOf(event),
    hashtags: hashtagsOf(event),
  }
}
