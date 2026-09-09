import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import type { NostrEvent, Signer } from './types'

/**
 * NIP-98: an HTTP request signed with the reader's own key.
 *
 * There are no passwords here and no accounts, so when a route has to know who is calling —
 * because what it does costs money, or is rate-limited per person — the only identity available
 * is a signature. This builds the event; `verifyNip98` in `@nostrich/api` checks it on the other
 * side, and the two must agree about the URL, the method and the body hash.
 *
 * THE `payload` TAG IS WHAT MAKES THIS SAFE FOR A POST. Without it the header is a bearer token:
 * anyone who sees one request can reattach the same header to a body of their choosing. With it
 * the signature covers the exact bytes, so a captured header authorises exactly the request it
 * was made for and nothing else.
 *
 * Deliberately NOT a session token, and deliberately short-lived (the verifier rejects anything
 * older than a minute): every call carries its own signature, so there is nothing to steal that
 * outlives the request it was made for.
 */

export const NIP98_KIND = 27235

/**
 * Signers show `content` to the reader when they prompt.
 *
 * A NIP-46 bunker pops a dialog for each signature, and "" tells the reader nothing about what
 * they are approving. Callers should pass something that reads as a sentence.
 */
const DEFAULT_CONTENT = 'HTTP request'

/**
 * Phone clocks run fast often enough to matter.
 *
 * The verifier rejects a future `created_at`, so a few seconds of backdate is the difference
 * between a working feature and a 401 that looks like a broken key. Same reasoning, and the same
 * constant, as the Blossom auth in `blossom.ts`.
 */
const CLOCK_SKEW_SECONDS = 10

export interface HttpAuthParams {
  /** Absolute URL, exactly as the request will address it. */
  url: string
  method: string
  /** The request body. Required for anything with one — see the note above. */
  body?: string
  /** Shown by NIP-07 and NIP-46 signers when they prompt for the signature. */
  content?: string
}

export async function createHttpAuth(signer: Signer, params: HttpAuthParams): Promise<NostrEvent> {
  const tags: string[][] = [
    ['u', params.url],
    ['method', params.method.toUpperCase()],
  ]
  if (params.body !== undefined) {
    tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(params.body)))])
  }

  return signer.signEvent({
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS,
    content: params.content ?? DEFAULT_CONTENT,
    tags,
  })
}

/** The `Authorization` header value. Base64 of the event's JSON, as the NIP specifies. */
export function httpAuthHeader(auth: NostrEvent): string {
  return `Nostr ${toBase64(new TextEncoder().encode(JSON.stringify(auth)))}`
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Hand-rolled, like the one in `blossom.ts`.
 *
 * `btoa` is a browser global and `Buffer` is a Node one; this package runs in a browser, in Node
 * and under Hermes on a phone, so it uses neither.
 */
function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1] ?? 0
    const b2 = bytes[i + 2] ?? 0
    const triple = (b0 << 16) | (b1 << 8) | b2
    out += B64_ALPHABET.charAt((triple >> 18) & 63)
    out += B64_ALPHABET.charAt((triple >> 12) & 63)
    out += i + 1 < bytes.length ? B64_ALPHABET.charAt((triple >> 6) & 63) : '='
    out += i + 2 < bytes.length ? B64_ALPHABET.charAt(triple & 63) : '='
  }
  return out
}
