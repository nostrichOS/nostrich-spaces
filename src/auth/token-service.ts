import { parseAddress } from '../core/events'
import { parseRoom } from '../events/room-event'
import { LIVE_FRESH_SECONDS, normalizeRole, spaceStatus } from '../events/space'
import type { Hex, NostrEvent } from '../core/types'
import { SignJWT, exportJWK, importJWK, type JWK, type KeyLike } from 'jose'

/**
 * THE TOKEN SERVICE FOR OUR AUDIO RELAY — the "moq-auth sidecar" of the audio-room protocol
 * (another client's EGG-02 and EGG-07), as two HTTP handlers rather than a container.
 *
 * A listener or a speaker proves who they are with a NIP-98 signature over
 * `POST <auth>/auth {namespace, publish}`, and gets back a ten-minute JWT the relay checks
 * against the public key it was started with. The JWT names the room (`root`), what the bearer
 * may read (`get: [""]`, everything under the room) and what they may write (`put`: their own
 * pubkey's broadcast, or nothing). That is the whole contract; the relay never reads Nostr.
 *
 * ── What the reference sidecar skips and this one does not ─────────────────────────────
 *
 * the reference sidecar mints `put` for anyone who asks `publish: true`. EGG-07 says the sidecar
 * MUST check the room's latest kind-30312 and grant publishing only to its author, or to a
 * pubkey it names as `speaker` or `admin`; EGG-08 says a room that is `planned` or `ended`
 * mints nothing. Both are done here, from the room's newest event on our relays, so a stranger
 * cannot walk onto anybody's stage by asking nicely.
 *
 * ── Keeps nothing ───────────────────────────────────────────────────────────────────────
 *
 * One private key in the environment, an in-memory set of auth-event ids for two minutes (a
 * signed header is otherwise replayable inside the NIP-98 window), and a thirty-second cache of
 * room events. No row, no log line with a pubkey. The key is the
 * identity; this turns a signature into a relay session, and nothing else.
 */

/** EGG-02: `exp` MUST be `iat + 600` for protocol today. */
export const TOKEN_LIFETIME_SECONDS = 600

/** EGG-02's namespace shape: `nests/<kind>:<host pubkey hex>:<room d>`, `d` in the EGG-01 charset. */
const NAMESPACE_PATTERN = /^nests\/(30312):([0-9a-f]{64}):([A-Za-z0-9._-]{1,64})$/

/** How long a room event answers for before the relays are asked again. */
const ROOM_CACHE_MS = 30_000

/** A signed auth event is one-shot for this long. Same window as the reference sidecar. */
const REPLAY_TTL_MS = 2 * 60_000

export interface TokenRequest {
  namespace: string
  /** `30312:<host>:<d>` — the namespace without its `nests/` prefix. */
  address: string
  host: Hex
  identifier: string
  publish: boolean
}

export type TokenRequestFailure = { ok: false; status: 400; code: 'bad_body' | 'bad_namespace'; message: string }

/** The body, exactly as EGG-02 shapes it. Unknown keys are ignored; a malformed namespace is refused. */
export function parseTokenRequest(raw: string): { ok: true; value: TokenRequest } | TokenRequestFailure {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, status: 400, code: 'bad_body', message: 'body must be a JSON object' }
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: 400, code: 'bad_body', message: 'body must be a JSON object' }
  }
  const namespace = (body as { namespace?: unknown }).namespace
  const publish = (body as { publish?: unknown }).publish
  if (typeof namespace !== 'string') {
    return { ok: false, status: 400, code: 'bad_namespace', message: 'namespace is required' }
  }
  const match = NAMESPACE_PATTERN.exec(namespace)
  if (match === null) {
    return { ok: false, status: 400, code: 'bad_namespace', message: 'namespace must be nests/30312:<pubkey>:<room>' }
  }
  const host = match[2]! as Hex
  const identifier = match[3]!
  return {
    ok: true,
    value: { namespace, address: `30312:${host}:${identifier}`, host, identifier, publish: publish === true },
  }
}

export type AccessDecision =
  | { ok: true; put: readonly Hex[] }
  | { ok: false; status: 403 | 404; code: 'room_unknown' | 'room_closed' | 'publish_forbidden'; message: string }

/**
 * Who may do what, from the room's newest event.
 *
 * The HOST is the address's own pubkey and needs no event at all: a room's first token request
 * is the host's, made the moment the room event is signed and often before any relay has stored
 * it. Everyone else is judged by the event — none yet means the room is not known; `planned` or
 * `ended` (or a `live` older than the eight-hour freshness rule) mints nothing; listening is open
 * to any signer; speaking needs a `speaker` or `admin` p-tag (`normalizeRole` reads both
 * generations of the vocabulary).
 */
export function decideAccess(
  request: TokenRequest,
  requester: Hex,
  room: NostrEvent | undefined,
  now: number,
): AccessDecision {
  const who = requester.toLowerCase() as Hex
  if (who === request.host) return { ok: true, put: request.publish ? [who] : [] }
  if (room === undefined) {
    return { ok: false, status: 404, code: 'room_unknown', message: 'no event for this room on our relays yet' }
  }
  if (room.kind !== 30312 || room.pubkey.toLowerCase() !== request.host) {
    return { ok: false, status: 404, code: 'room_unknown', message: 'the event is not this room' }
  }
  const parsed = parseRoom(room)
  if (parsed.identifier !== request.identifier) {
    return { ok: false, status: 404, code: 'room_unknown', message: 'the event is not this room' }
  }
  const status = spaceStatus(
    parsed.status,
    { starts: parsed.starts, ends: parsed.ends, updatedAt: room.created_at },
    now,
    LIVE_FRESH_SECONDS,
  )
  if (status !== 'live') return { ok: false, status: 403, code: 'room_closed', message: 'the room is not live' }
  if (!request.publish) return { ok: true, put: [] }
  const role = parsed.participants.find(participant => participant.pubkey === who)
  const normalized = role === undefined ? 'listener' : normalizeRole(role.role)
  if (normalized === 'speaker' || normalized === 'cohost' || normalized === 'moderator' || normalized === 'host') {
    return { ok: true, put: [who] }
  }
  return { ok: false, status: 403, code: 'publish_forbidden', message: 'not a speaker in this room' }
}

/** The relay's own claim shape (moq-token): a root path, then suffixes the bearer may read and write. */
export interface RelayClaims {
  root: string
  get: readonly string[]
  put: readonly Hex[]
}

export interface RelaySigner {
  key: KeyLike
  kid: string
  /** The public half, as the relay and the JWKS route hand it out. */
  jwk: JWK
}

/**
 * The signing key from its JSON Web Key in the environment (`MOQ_AUTH_PRIVATE_JWK`, a private
 * EC P-256 key with a `kid`). Undefined when unset: the routes then answer `unconfigured`, and a
 * checkout without a relay still runs — the same rule the translation key follows.
 */
export async function loadRelaySigner(raw: string | undefined): Promise<RelaySigner | undefined> {
  if (raw === undefined || raw.trim() === '') return undefined
  const jwk = JSON.parse(raw) as JWK
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') {
    throw new Error('MOQ_AUTH_PRIVATE_JWK must be a private EC P-256 key')
  }
  const key = (await importJWK(jwk, 'ES256')) as KeyLike
  const { d: _d, ...rest } = jwk
  const kid = typeof jwk.kid === 'string' && jwk.kid !== '' ? jwk.kid : 'moq-auth-1'
  const pub: JWK = { ...(await exportJWK((await importJWK(rest, 'ES256')) as KeyLike)), kid, alg: 'ES256', use: 'sig' }
  return { key, kid, jwk: pub }
}

/** EGG-02 §2: ES256, `root`/`get`/`put`, `iat`, `exp = iat + 600`. */
export async function mintRelayToken(signer: RelaySigner, claims: RelayClaims, now: number): Promise<string> {
  return new SignJWT({ root: claims.root, get: [...claims.get], put: [...claims.put] })
    .setProtectedHeader({ alg: 'ES256', kid: signer.kid, typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
    .sign(signer.key)
}

/** The JWKS document the relay and anyone else verifies against. */
export function relayJwks(signer: RelaySigner): { keys: JWK[] } {
  return { keys: [signer.jwk] }
}

/**
 * One auth event, one token. The NIP-98 window is a minute and a signed header is a bearer
 * inside it; the reference sidecar keeps ids for two minutes and so does this.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>()

  /** True the first time an id is offered inside the window; false ever after. */
  admit(eventId: string, nowMs: number): boolean {
    for (const [id, until] of this.seen) if (until <= nowMs) this.seen.delete(id)
    if (this.seen.has(eventId)) return false
    this.seen.set(eventId, nowMs + REPLAY_TTL_MS)
    return true
  }
}

export type RoomLookup = (address: string) => Promise<NostrEvent | undefined>

/**
 * The room's newest event, asked once per half minute per room. The underlying lookup is
 * injected: the route hands in a relay query, the tests hand in a map.
 */
export class RoomCache {
  private readonly rooms = new Map<string, { until: number; event: NostrEvent | undefined }>()

  constructor(private readonly lookup: RoomLookup) {}

  async get(address: string, nowMs: number): Promise<NostrEvent | undefined> {
    const cached = this.rooms.get(address)
    if (cached !== undefined && cached.until > nowMs) return cached.event
    const event = await this.lookup(address).catch(() => undefined)
    // A miss is cached briefly too, or a stranger could make the relays answer per request.
    this.rooms.set(address, { until: nowMs + (event === undefined ? 5_000 : ROOM_CACHE_MS), event })
    return event
  }
}

/** The newest of several revisions a relay may answer with, and only the one for this address. */
export function newestRoomEvent(address: string, events: readonly NostrEvent[]): NostrEvent | undefined {
  const parsed = parseAddress(address)
  if (parsed === undefined) return undefined
  let newest: NostrEvent | undefined
  for (const event of events) {
    if (event.kind !== parsed.kind || event.pubkey.toLowerCase() !== parsed.pubkey) continue
    if (parseRoom(event).identifier !== parsed.identifier) continue
    if (newest === undefined || event.created_at > newest.created_at) newest = event
  }
  return newest
}
