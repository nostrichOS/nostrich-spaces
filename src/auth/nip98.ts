import { createHash } from 'node:crypto'

import { verifyEvent } from 'nostr-tools/pure'

import type { Hex, NostrEvent } from '../core/types'

/**
 * NIP-98 HTTP Auth — the only authentication in this system.
 *
 * There are no passwords, no sessions, no accounts and no user table. The caller
 * proves control of a Nostr key by signing a short-lived event that names the exact
 * URL and HTTP method it is authorising, and the pubkey that comes out the other side
 * IS the identity. Everything server-side keys off that pubkey.
 */

/** NIP-98 `kind`. Exported so no route has to write the integer itself. */
export const NIP98_KIND = 27235

/**
 * Accepted clock skew, in seconds, in EITHER direction.
 *
 * Why there is no nonce table, and why that is not an oversight:
 *
 * A replayed NIP-98 header is only useful against the endpoint it was minted for. The
 * signature covers the `u` and `method` tags, so a captured header cannot be pointed
 * at a different route or turned from a GET into a DELETE — the two things a stolen
 * bearer token is normally good for. What is left is replaying the same call to the
 * same endpoint inside this window, and every endpoint this guards is idempotent with
 * respect to the signing key: re-claiming the name you already hold, or re-registering
 * the device token you already own, converges on the row that is already there.
 *
 * A nonce store would buy the difference between "replayable for 60 seconds" and
 * "replayable never", against an attacker who is already reading the user's TLS
 * traffic, and would cost a write on every authenticated request, an eviction job, and
 * a piece of shared mutable state between the web container and the push worker.
 *
 * Revisit this the moment a non-idempotent authenticated endpoint appears — a
 * transfer, a payment, a delete of something that cannot be recreated. The window is
 * acceptable only because replaying inside it is currently a no-op.
 */
export const NIP98_MAX_AGE_SECONDS = 60

/**
 * nginx and Node both cap request headers around 8KB. A NIP-98 event is ~500 bytes, so
 * anything near the cap is someone probing the JSON parser rather than a client.
 */
const MAX_HEADER_CHARS = 8192

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

export type Nip98FailureCode =
  | 'missing_header'
  | 'malformed_header'
  | 'malformed_event'
  | 'wrong_kind'
  | 'url_mismatch'
  | 'method_mismatch'
  | 'expired'
  | 'payload_mismatch'
  | 'invalid_signature'

export interface Nip98Failure {
  ok: false
  code: Nip98FailureCode
  /**
   * Safe to return to the caller verbatim. Every failure here is about an event the
   * caller wrote themselves, so there is nothing to leak by being specific — and a
   * generic "unauthorized" turns a clock-skew bug into an afternoon of guessing.
   */
  message: string
}

export interface Nip98Success {
  ok: true
  /** Lowercase hex. The authenticated identity. */
  pubkey: Hex
  /** The verified event, for handlers that want its tags. */
  event: NostrEvent
}

export type Nip98Result = Nip98Success | Nip98Failure

export interface Nip98Input {
  /** Request URL. Absolute; see `origin` in the options for the proxy case. */
  url: string
  method: string
  /** Raw `Authorization` header value, exactly as received. */
  authorization: string | null | undefined
  /**
   * Raw request body. When supplied, the event's `payload` tag is REQUIRED and must be
   * its SHA-256 — that is what stops a captured header from being reattached to
   * different bytes. Omit for bodyless requests.
   */
  body?: string | Uint8Array
}

export interface Nip98Options {
  /**
   * Public origin the client actually addressed, e.g. `https://nostrich.org`.
   *
   * Required in production. We sit behind Cloudflare and then the host's nginx, so by
   * the time a request reaches Next.js its URL says `http://localhost:3400` while the
   * client signed `https://nostrich.org` — comparing them raw fails every legitimate
   * request. The origin is taken from OUR configuration rather than from
   * `X-Forwarded-Host`, because a header an attacker can set is not a thing to
   * validate a signature against.
   */
  origin?: string
  /** Defaults to NIP98_MAX_AGE_SECONDS. */
  maxAgeSeconds?: number
  /** Unix seconds. Injectable so the tests do not depend on the wall clock. */
  now?: number
}

/** Minimal shape of a fetch `Request`, so this package needs no DOM lib at runtime. */
export interface RequestLike {
  url: string
  method: string
  headers: { get(name: string): string | null }
}

/**
 * Adapter for Next.js route handlers. Read the body yourself and pass it in — a
 * `Request` body is a one-shot stream, and consuming it here would leave the handler
 * with nothing to parse.
 */
export function nip98InputFromRequest(request: RequestLike, body?: string | Uint8Array): Nip98Input {
  const input: Nip98Input = {
    url: request.url,
    method: request.method,
    authorization: request.headers.get('authorization'),
  }
  if (body !== undefined) input.body = body
  return input
}

export function verifyNip98(input: Nip98Input, options: Nip98Options = {}): Nip98Result {
  const encoded = readAuthorizationValue(input.authorization)
  if (encoded === null) {
    return input.authorization === null || input.authorization === undefined || input.authorization.trim() === ''
      ? fail('missing_header', 'missing Authorization header')
      : fail('malformed_header', 'Authorization header must be "Nostr <base64-encoded event>"')
  }
  if (encoded.length > MAX_HEADER_CHARS) {
    return fail('malformed_header', 'Authorization header is too large to be a NIP-98 event')
  }

  const decoded = decodeBase64Json(encoded)
  if (decoded === undefined) return fail('malformed_header', 'Authorization payload is not base64-encoded JSON')

  const event = parseEvent(decoded)
  if (event === null) return fail('malformed_event', 'Authorization payload is not a well-formed Nostr event')

  if (event.kind !== NIP98_KIND) {
    return fail('wrong_kind', `expected kind ${NIP98_KIND}, got ${event.kind}`)
  }

  const expectedUrl = canonicalUrl(input.url, options.origin)
  const claimedUrl = canonicalUrl(firstTagValue(event.tags, 'u'))
  if (expectedUrl === null) {
    return fail('url_mismatch', 'request URL could not be canonicalised')
  }
  if (claimedUrl === null || claimedUrl !== expectedUrl) {
    return fail('url_mismatch', `auth event is not bound to ${expectedUrl}`)
  }

  const expectedMethod = input.method.trim().toUpperCase()
  const claimedMethod = firstTagValue(event.tags, 'method')?.trim().toUpperCase()
  if (claimedMethod === undefined || claimedMethod !== expectedMethod) {
    return fail('method_mismatch', `auth event is not bound to ${expectedMethod}`)
  }

  const maxAge = options.maxAgeSeconds ?? NIP98_MAX_AGE_SECONDS
  const now = options.now ?? Math.floor(Date.now() / 1000)
  // Symmetric: phone clocks run fast at least as often as they run slow, and a future
  // created_at is a wrong clock, not an attack — the signature is what stops attacks.
  if (Math.abs(now - event.created_at) > maxAge) {
    return fail('expired', `auth event created_at must be within ${maxAge}s of server time`)
  }

  if (input.body !== undefined) {
    const claimedPayload = firstTagValue(event.tags, 'payload')?.trim().toLowerCase()
    if (claimedPayload === undefined) {
      return fail('payload_mismatch', 'auth event is missing the payload tag required for a request with a body')
    }
    if (claimedPayload !== sha256Hex(input.body)) {
      return fail('payload_mismatch', 'auth event payload tag does not match the request body')
    }
  }

  // Signature last on purpose: it is the only expensive check here, and putting it
  // behind the cheap structural ones means unsigned junk cannot make us burn schnorr
  // verifications. Nothing above this line leaks anything — every value it compares was
  // written by the caller.
  if (!safeVerify(event)) return fail('invalid_signature', 'auth event signature is invalid')

  return { ok: true, pubkey: event.pubkey, event }
}

function fail(code: Nip98FailureCode, message: string): Nip98Failure {
  return { ok: false, code, message }
}

/** Returns the base64 blob, or null when the header is absent or not a Nostr scheme. */
function readAuthorizationValue(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null
  const trimmed = header.trim()
  if (trimmed === '') return null
  const separator = trimmed.search(/\s/)
  if (separator < 0) return null
  // The auth-scheme token is case-insensitive per RFC 7235; clients in the wild send
  // both "Nostr" and "nostr".
  if (trimmed.slice(0, separator).toLowerCase() !== 'nostr') return null
  const value = trimmed.slice(separator + 1).trim()
  return value === '' ? null : value
}

function decodeBase64Json(value: string): unknown {
  let json: string
  try {
    json = Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return undefined
  }
  if (json === '') return undefined
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

/**
 * Rebuilds a NostrEvent from untrusted JSON, field by field.
 *
 * Hex is required to be lowercase rather than normalised: lowercasing a pubkey after
 * the fact would change the bytes the id was computed over, and passing an uppercase
 * one through would put a key into the rest of the system that fails every comparison
 * against the lowercase hex everything else stores.
 */
function parseEvent(value: unknown): NostrEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>

  const id = record['id']
  const pubkey = record['pubkey']
  const sig = record['sig']
  if (typeof id !== 'string' || !HEX64.test(id)) return null
  if (typeof pubkey !== 'string' || !HEX64.test(pubkey)) return null
  if (typeof sig !== 'string' || !HEX128.test(sig)) return null

  const kind = record['kind']
  const createdAt = record['created_at']
  const content = record['content']
  if (typeof kind !== 'number' || !Number.isInteger(kind)) return null
  if (typeof createdAt !== 'number' || !Number.isInteger(createdAt)) return null
  if (typeof content !== 'string') return null

  const rawTags = record['tags']
  if (!Array.isArray(rawTags)) return null
  const tags: string[][] = []
  for (const rawTag of rawTags) {
    if (!Array.isArray(rawTag)) return null
    const tag: string[] = []
    for (const item of rawTag) {
      if (typeof item !== 'string') return null
      tag.push(item)
    }
    tags.push(tag)
  }

  return { id, pubkey, sig, kind, created_at: createdAt, content, tags }
}

/** verifyEvent throws on some malformed shapes, and this input is hostile by definition. */
function safeVerify(event: NostrEvent): boolean {
  try {
    return verifyEvent(event)
  } catch {
    return false
  }
}

function firstTagValue(tags: readonly (readonly string[])[], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name && tag[1] !== undefined) return tag[1]
  }
  return undefined
}

/**
 * Scheme, host, path and query — never the fragment, which is never transmitted to a
 * server, so a `u` tag carrying one is a broken client at best.
 *
 * Both sides of the comparison go through this, so percent-encoding and default-port
 * spellings normalise identically. Trailing slashes are deliberately NOT normalised:
 * `/api/name` and `/api/name/` are different resources and collapsing them would let a
 * header signed for one authorise the other.
 */
function canonicalUrl(raw: string | undefined, origin?: string): string | null {
  if (raw === undefined) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  let authority = `${url.protocol}//${url.host}`
  if (origin !== undefined) {
    let base: URL
    try {
      base = new URL(origin)
    } catch {
      return null
    }
    // Composed from the base rather than assigned through `url.protocol` / `url.host`:
    // the WHATWG host setter keeps the existing port when the new value has none, so
    // rewriting `http://localhost:3400` to `nostrich.org` would silently yield
    // `https://nostrich.org:3400` and fail every request behind the proxy.
    authority = `${base.protocol}//${base.host}`
  }
  return `${authority}${url.pathname}${url.search}`
}

function sha256Hex(body: string | Uint8Array): string {
  return typeof body === 'string'
    ? createHash('sha256').update(body, 'utf8').digest('hex')
    : createHash('sha256').update(body).digest('hex')
}
