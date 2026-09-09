import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

import type { EventTemplate, Hex, NostrEvent, Signer } from './types'

/**
 * A `Signer` over a local secret key — enough to sign a token request or a room event. A
 * listener signs its token request with a key made for the occasion and thrown away, which is
 * what `PrivateKeySigner.generate()` is for: nobody's real key is asked to sign for somebody
 * else's server for the privilege of hearing them.
 */
export class PrivateKeySigner implements Signer {
  private constructor(private readonly secretKey: Uint8Array) {}

  static generate(): PrivateKeySigner {
    return new PrivateKeySigner(generateSecretKey())
  }

  static fromSecretKey(secretKey: Uint8Array): PrivateKeySigner {
    if (secretKey.length !== 32) throw new Error('a secret key is 32 bytes')
    return new PrivateKeySigner(secretKey)
  }

  static fromHex(hex: string): PrivateKeySigner {
    const clean = hex.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('a secret key is 64 hex characters')
    return new PrivateKeySigner(Uint8Array.from(clean.match(/../g)!.map(pair => Number.parseInt(pair, 16))))
  }

  async getPublicKey(): Promise<Hex> {
    return getPublicKey(this.secretKey)
  }

  async signEvent(template: EventTemplate): Promise<NostrEvent> {
    return finalizeEvent({ ...template, tags: template.tags.map(tag => [...tag]) }, this.secretKey)
  }
}
