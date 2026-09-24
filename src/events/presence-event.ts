import { getTagValues } from '../core/events'
import type { Hex, NostrEvent } from '../core/types'

/**
 * NIP-53 ROOM PRESENCE — kind 10312, "I am in this room right now".
 *
 * A replaceable heartbeat: a client in a room republishes it every thirty seconds or so, with
 * an `a` tag naming the room, so anyone reading the relay can count who is listening without a
 * server to ask. Replaceable means one per pubkey, so a person can be present in one room at a
 * time — which is what makes the count honest.
 *
 * Measured on 2026-09-08 across eleven relays, including the ones the rooms themselves name:
 * ZERO presence events in the previous hour. the protocol publishes them while a room runs; one service
 * never does. So a count built from these is real when it exists and usually does not exist,
 * and every surface drawing it has to be able to say nothing rather than `0`.
 *
 * Parsing only. The heartbeat our own rooms publish is built in `room-builders.ts`; the four
 * flags here are the four EGG-04 defines, and a client that omits one is read as `0` for it.
 * The fifth, `left`, is ours: the last beat a Nostrich client sends, which says the person has
 * gone rather than stepped off the stage (`buildDeparture`).
 */

/** NIP-53 room presence. Replaceable: one per pubkey, republished as a heartbeat. */
export const PRESENCE_KIND = 10312

/**
 * How recent a heartbeat has to be to count somebody as present.
 *
 * Six minutes, EGG-04 rule 2: the heartbeat is every thirty seconds, so this is one missed beat
 * plus a five-minute tolerance, and anything older is a client that left without saying so.
 */
export const PRESENCE_FRESH_SECONDS = 6 * 60

export interface PresenceEvent {
  pubkey: Hex
  /** The room's address — `30312:pubkey:d` — or undefined when the tag is missing or malformed. */
  room: string | undefined
  handRaised: boolean
  /** `undefined` when the client did not say, which is most of them. */
  muted: boolean | undefined
  /** An open audio broadcast on the relay right now (EGG-04). */
  publishing: boolean | undefined
  /** Holds a speaker slot and has not stepped off (EGG-04). */
  onstage: boolean | undefined
  /** The last beat of somebody who has LEFT the room (`["left", "1"]`, see `buildDeparture`). */
  left: boolean
  /** Unix seconds of the heartbeat. */
  at: number
}

function flag(event: NostrEvent, name: string): boolean | undefined {
  const value = getTagValues(event, name)[0]?.trim()
  if (value === undefined) return undefined
  return value === '1' || value.toLowerCase() === 'true'
}

export function isPresenceEvent(event: NostrEvent): boolean {
  return event.kind === PRESENCE_KIND
}

export function parsePresence(event: NostrEvent): PresenceEvent {
  const room = getTagValues(event, 'a')[0]?.trim()
  return {
    pubkey: event.pubkey as Hex,
    room: room === undefined || !/^\d+:[0-9a-f]{64}:/.test(room) ? undefined : room,
    handRaised: flag(event, 'hand') === true,
    muted: flag(event, 'muted'),
    publishing: flag(event, 'publishing'),
    onstage: flag(event, 'onstage'),
    left: flag(event, 'left') === true,
    at: event.created_at,
  }
}
