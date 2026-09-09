import { getTagValues, getTags } from '../core/events'
import type { Hex, NostrEvent } from '../core/types'

/**
 * NIP-53 LIVE EVENTS — the addressable event a `nostr:naddr…` in a note usually points at.
 *
 * Streams are the one addressable kind people share into a timeline constantly, and until this
 * existed the pointer rendered as fourteen characters of bech32 — the same fourteen for every
 * stream on the network, because a kind-30311 TLV opens with type-0/len-36. Reported as
 * "streams naddrs aren't working on notes", and it was not working in the strongest sense: the
 * reader was shown a constant.
 *
 * PARSING ONLY. Nothing here fetches, and nothing decides how a card looks — this turns a bag
 * of tags into the handful of facts a card needs, on every platform, and is tested on its own.
 * That split is why the same struct can back a web card and a React Native one later.
 */

/** NIP-53 live event. Addressable: identified by `kind:pubkey:d`, republished as it changes. */
export const LIVE_EVENT_KIND = 30311

/**
 * The three states NIP-53 defines, plus our reading of a missing one.
 *
 * `status` is optional in the spec and plenty of hosts omit it, so absence has to mean
 * something. It means "unknown" rather than "ended": announcing a stream as over when the tag
 * simply was not written is the one error a reader acts on — they do not click.
 */
export type LiveStatus = 'planned' | 'live' | 'ended' | 'unknown'

export interface LiveEvent {
  identifier: string
  title: string | undefined
  summary: string | undefined
  image: string | undefined
  status: LiveStatus
  /** Unix seconds, when the host wrote them. */
  starts: number | undefined
  ends: number | undefined
  /** Watching right now, per the host. Absent is not zero — see `participants`. */
  currentParticipants: number | undefined
  totalParticipants: number | undefined
  /**
   * Whoever the event names as Host, falling back to the event's author.
   *
   * A stream is very often published by a PLATFORM key rather than by the streamer — the note
   * that prompted this was authored by `another service` on the streamer's behalf — so drawing the author's
   * avatar would put the service's face on somebody else's stream.
   */
  host: Hex
  /** A player the host advertises. Never auto-opened; the card only ever links. */
  streaming: string | undefined
  recording: string | undefined
}

function firstTag(event: NostrEvent, name: string): string | undefined {
  const value = getTagValues(event, name)[0]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * A tag whose value must be a non-negative integer.
 *
 * Written by whoever ran the stream, so `"0"`, `""`, `"none"` and a float are all things that
 * actually arrive. Anything that is not a clean count is dropped rather than coerced: `NaN`
 * rendered into a card reads as a bug in us, and `0` claimed from a missing tag is a lie about
 * somebody's audience.
 */
function count(event: NostrEvent, name: string): number | undefined {
  const raw = firstTag(event, name)
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) ? value : undefined
}

function seconds(event: NostrEvent, name: string): number | undefined {
  const value = count(event, name)
  // A zero timestamp is 1970 and means the tag was written empty. Never a real stream time.
  return value === undefined || value === 0 ? undefined : value
}

function statusOf(event: NostrEvent): LiveStatus {
  switch (firstTag(event, 'status')?.toLowerCase()) {
    case 'live':
      return 'live'
    case 'ended':
      return 'ended'
    case 'planned':
      return 'planned'
    default:
      return 'unknown'
  }
}

/**
 * The host, read from the `p` tag NIP-53 marks with the role `Host`.
 *
 * Case-insensitive: the spec writes "Host" and implementations write "host". Matching only the
 * capitalised form put the publishing platform's avatar on the card for every stream from any
 * client that lower-cased it.
 */
function hostOf(event: NostrEvent): Hex {
  for (const tag of getTags(event, 'p')) {
    const pubkey = tag[1]
    if (pubkey === undefined || pubkey.length !== 64) continue
    if ((tag[3] ?? '').trim().toLowerCase() === 'host') return pubkey as Hex
  }
  return event.pubkey as Hex
}

/** Whether this event is a live stream at all. */
export function isLiveEvent(event: NostrEvent): boolean {
  return event.kind === LIVE_EVENT_KIND
}

export function parseLiveEvent(event: NostrEvent): LiveEvent {
  return {
    identifier: firstTag(event, 'd') ?? '',
    title: firstTag(event, 'title'),
    summary: firstTag(event, 'summary'),
    image: firstTag(event, 'image'),
    status: statusOf(event),
    starts: seconds(event, 'starts'),
    ends: seconds(event, 'ends'),
    currentParticipants: count(event, 'current_participants'),
    totalParticipants: count(event, 'total_participants'),
    host: hostOf(event),
    streaming: firstTag(event, 'streaming'),
    recording: firstTag(event, 'recording'),
  }
}

/**
 * The moment a card should date the stream by.
 *
 * A live stream is dated by when it STARTED and a finished one by when it ENDED, because those
 * are the two facts a reader is asking about — "how long has this been running" and "how long
 * ago did I miss it". Falling back to the other end, and finally to the event's own timestamp,
 * because a card with no time at all reads as broken.
 */
export function liveEventAt(live: LiveEvent, event: NostrEvent): number {
  if (live.status === 'ended') return live.ends ?? live.starts ?? event.created_at
  return live.starts ?? live.ends ?? event.created_at
}
