import { SimplePool } from 'nostr-tools/pool'

import { parseAddress } from '../core/events'
import type { Hex, NostrEvent, RelayUrl } from '../core/types'
import { nip98InputFromRequest, verifyNip98 } from './nip98'
import {
  ReplayGuard,
  RoomCache,
  decideAccess,
  loadRelaySigner,
  mintRelayToken,
  newestRoomEvent,
  parseTokenRequest,
  relayJwks,
  type RelaySigner,
} from './token-service'

/**
 * THE TOKEN SERVICE AS TWO PLAIN HANDLERS — `handleAuth` for `POST <auth>/auth` and
 * `handleJwks` for `GET <auth>/.well-known/jwks.json` — on the web-standard `Request` and
 * `Response`, so they drop into Next.js, Hono, Bun, Deno, a Cloudflare Worker or a bare Node
 * server alike. `examples/next-route.ts` shows one wiring.
 *
 * Answers follow EGG-02's taxonomy: 401 for a signature that does not hold, 403 `room_closed`
 * or `publish_forbidden`, 404 `room_unknown`, 409 for a reused auth event, 503 `unconfigured`
 * when no signing key is set.
 *
 * ── What it keeps ─────────────────────────────────────────────────────────────────────
 *
 * One private key, an in-memory replay set for two minutes, a thirty-second cache of room
 * events. No database. One process: a second replica would need the replay set shared, which
 * is a deliberate non-feature until somebody needs it.
 */
export interface TokenServiceConfig {
  /** The private EC P-256 JWK the relay's public key was generated with (`scripts/keygen.mjs`). */
  privateJwk: string | undefined
  /**
   * The public origin clients address, e.g. `https://rooms.example.org`. A NIP-98 event names
   * the URL it was signed for, and behind a proxy the server sees a different one.
   */
  origin: string
  /** Where a room's newest kind-30312 is looked for when the requester is not its host. */
  relays: readonly RelayUrl[]
  /** Override the relay lookup entirely — tests hand in a map. */
  lookup?: (address: string) => Promise<NostrEvent | undefined>
  /** Milliseconds to wait for the relays. Default 4000. */
  lookupTimeoutMs?: number
}

/** The same for every answer: any origin may ask, nothing is cached. */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
  'cache-control': 'no-store',
}

const BODY_LIMIT = 4_096

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, ...extra } })
}

/**
 * Whether a NIP-98 header carries a `payload` tag. EGG-02 says it MUST; the deployed clients
 * disagree (another client writes it, the the protocol web client does not), so the body is checked
 * against the tag when the tag exists and the request is not refused when it does not. The
 * namespace and the pubkey are what the token is scoped to, and the replay guard keeps a
 * captured header from being reused inside the NIP-98 minute.
 */
export function headerHasPayload(authorization: string | null): boolean {
  if (authorization === null || !authorization.startsWith('Nostr ')) return false
  try {
    const raw = authorization.slice(6).trim()
    const decoded = typeof atob === 'function' ? atob(raw) : Buffer.from(raw, 'base64').toString('utf8')
    const event = JSON.parse(decoded) as { tags?: unknown }
    return Array.isArray(event.tags) && event.tags.some(tag => Array.isArray(tag) && tag[0] === 'payload')
  } catch {
    return false
  }
}

/** The room's newest event from the relays, with nostr-tools' pool. Needs a global `WebSocket` (Node 22+ has one). */
function relayLookup(relays: readonly RelayUrl[], timeoutMs: number): (address: string) => Promise<NostrEvent | undefined> {
  const pool = new SimplePool()
  return async address => {
    const parsed = parseAddress(address)
    if (parsed === undefined) return undefined
    const events = await pool.querySync(
      [...relays],
      { kinds: [parsed.kind], authors: [parsed.pubkey], '#d': [parsed.identifier], limit: 3 },
      { maxWait: timeoutMs },
    )
    return newestRoomEvent(address, events)
  }
}

export interface TokenService {
  handleAuth(request: Request): Promise<Response>
  handleJwks(): Promise<Response>
  handleOptions(): Response
}

export function createTokenService(config: TokenServiceConfig): TokenService {
  let signerPromise: Promise<RelaySigner | undefined> | undefined
  const signer = (): Promise<RelaySigner | undefined> => {
    if (signerPromise === undefined) {
      signerPromise = loadRelaySigner(config.privateJwk).catch(error => {
        signerPromise = undefined
        throw error
      })
    }
    return signerPromise
  }
  const replayGuard = new ReplayGuard()
  const roomCache = new RoomCache(config.lookup ?? relayLookup(config.relays, config.lookupTimeoutMs ?? 4_000))

  return {
    handleOptions(): Response {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    },

    async handleJwks(): Promise<Response> {
      const key = await signer()
      if (key === undefined) return json({ code: 'unconfigured', error: 'no relay signing key on this server' }, 503)
      return json(relayJwks(key), 200, { 'cache-control': 'public, max-age=60' })
    },

    async handleAuth(request: Request): Promise<Response> {
      const key = await signer()
      if (key === undefined) return json({ code: 'unconfigured', error: 'no relay signing key on this server' }, 503)

      const raw = await request.text()
      if (raw.length > BODY_LIMIT) return json({ code: 'too_large', error: 'body too large' }, 413)

      const authorization = request.headers.get('authorization')
      const auth = verifyNip98(nip98InputFromRequest(request, headerHasPayload(authorization) ? raw : undefined), {
        origin: config.origin,
      })
      if (!auth.ok) return json({ code: auth.code, error: auth.message }, 401)

      const nowMs = Date.now()
      if (!replayGuard.admit(auth.event.id, nowMs)) return json({ code: 'replay', error: 'Auth event already used' }, 409)

      const parsed = parseTokenRequest(raw)
      if (!parsed.ok) return json({ code: parsed.code, error: parsed.message }, parsed.status)

      const now = Math.floor(nowMs / 1000)
      const requester = auth.pubkey as Hex
      // The host needs no lookup; everyone else is judged by the room's newest event.
      const room = requester.toLowerCase() === parsed.value.host ? undefined : await roomCache.get(parsed.value.address, nowMs)
      const decision = decideAccess(parsed.value, requester, room, now)
      if (!decision.ok) return json({ code: decision.code, error: decision.message }, decision.status)

      const token = await mintRelayToken(key, { root: parsed.value.namespace, get: [''], put: decision.put }, now)
      return json({ token }, 200)
    },
  }
}
