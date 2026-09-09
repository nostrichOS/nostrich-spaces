import { exportJWK, generateKeyPair, jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'

import type { NostrEvent } from '../core/types'
import {
  ReplayGuard,
  RoomCache,
  decideAccess,
  loadRelaySigner,
  mintRelayToken,
  newestRoomEvent,
  parseTokenRequest,
  relayJwks,
} from './token-service'

const NOW = 1_789_000_000
const HOST = 'a1'.repeat(32)
const SPEAKER = 'c3'.repeat(32)
const ADMIN = 'b2'.repeat(32)
const STRANGER = 'd4'.repeat(32)

const room = (status: string, over: Partial<NostrEvent> = {}, extraTags: string[][] = [], d = 'abc123'): NostrEvent =>
  ({
    id: 'e'.repeat(64),
    pubkey: HOST,
    kind: 30312,
    created_at: NOW - 60,
    content: '',
    sig: '',
    tags: [
      ['d', d],
      ['title', 'Coffee'],
      ['status', status],
      ['streaming', 'https://moq.nostrich.org:4443'],
      ['auth', 'https://nostrich.org/api/moq'],
      ['p', HOST, '', 'host'],
      ['p', ADMIN, '', 'admin'],
      ['p', SPEAKER, '', 'speaker'],
      ...extraTags,
    ],
    ...over,
  }) as NostrEvent

const request = (publish: boolean) => {
  const parsed = parseTokenRequest(JSON.stringify({ namespace: `nests/30312:${HOST}:abc123`, publish }))
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

describe('parseTokenRequest', () => {
  it('reads the EGG-02 body and refuses anything that is not a room namespace', () => {
    const ok = parseTokenRequest(JSON.stringify({ namespace: `nests/30312:${HOST}:abc123`, publish: true }))
    expect(ok).toEqual({
      ok: true,
      value: { namespace: `nests/30312:${HOST}:abc123`, address: `30312:${HOST}:abc123`, host: HOST, identifier: 'abc123', publish: true },
    })
    expect(parseTokenRequest('nope').ok).toBe(false)
    expect(parseTokenRequest('[]').ok).toBe(false)
    expect(parseTokenRequest(JSON.stringify({ namespace: `nests/30311:${HOST}:abc` })).ok).toBe(false)
    expect(parseTokenRequest(JSON.stringify({ namespace: `nests/30312:${HOST}:has:colon` })).ok).toBe(false)
    expect(parseTokenRequest(JSON.stringify({ namespace: `nests/30312:${HOST.toUpperCase()}:abc` })).ok).toBe(false)
    // `publish` is a boolean or nothing; a string is nothing.
    const listen = parseTokenRequest(JSON.stringify({ namespace: `nests/30312:${HOST}:abc123`, publish: 'true' }))
    expect(listen.ok && listen.value.publish).toBe(false)
  })
})

describe('decideAccess', () => {
  it('lets the host in with or without an event, publishing when asked', () => {
    expect(decideAccess(request(true), HOST, undefined, NOW)).toEqual({ ok: true, put: [HOST] })
    expect(decideAccess(request(false), HOST.toUpperCase(), undefined, NOW)).toEqual({ ok: true, put: [] })
    expect(decideAccess(request(true), HOST, room('planned'), NOW)).toEqual({ ok: true, put: [HOST] })
  })

  it('knows nothing about a room it has not seen, for anyone but the host', () => {
    expect(decideAccess(request(false), SPEAKER, undefined, NOW)).toMatchObject({ ok: false, status: 404, code: 'room_unknown' })
    // The wrong event — another host's room — is no event.
    expect(decideAccess(request(false), SPEAKER, room('live', { pubkey: STRANGER }), NOW)).toMatchObject({ code: 'room_unknown' })
    expect(decideAccess(request(false), SPEAKER, room('live', {}, [], 'other'), NOW)).toMatchObject({ code: 'room_unknown' })
  })

  it('mints nothing for a planned, ended or stale room (EGG-08)', () => {
    expect(decideAccess(request(false), SPEAKER, room('planned', {}, [['starts', String(NOW + 3600)]]), NOW)).toMatchObject({ status: 403, code: 'room_closed' })
    expect(decideAccess(request(false), SPEAKER, room('ended'), NOW)).toMatchObject({ code: 'room_closed' })
    expect(decideAccess(request(false), SPEAKER, room('closed'), NOW)).toMatchObject({ code: 'room_closed' })
    expect(decideAccess(request(false), SPEAKER, room('live', { created_at: NOW - 9 * 3600 }), NOW)).toMatchObject({ code: 'room_closed' })
  })

  it('lets anyone listen to a live room and only the named people speak (EGG-07)', () => {
    const live = room('live')
    expect(decideAccess(request(false), STRANGER, live, NOW)).toEqual({ ok: true, put: [] })
    expect(decideAccess(request(true), STRANGER, live, NOW)).toMatchObject({ status: 403, code: 'publish_forbidden' })
    expect(decideAccess(request(true), SPEAKER, live, NOW)).toEqual({ ok: true, put: [SPEAKER] })
    expect(decideAccess(request(true), ADMIN, live, NOW)).toEqual({ ok: true, put: [ADMIN] })
    // The older vocabulary counts too — `open`, `Speaker`, `Moderator`.
    const older = room('open', {}, [['p', STRANGER, '', 'Moderator']])
    expect(decideAccess(request(true), STRANGER, older, NOW)).toEqual({ ok: true, put: [STRANGER] })
  })
})

describe('the token', () => {
  it('is an ES256 JWT with the relay claims, ten minutes long, verifiable against the JWKS', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    const jwk = { ...(await exportJWK(pair.privateKey)), kid: 'test-1' }
    const signer = await loadRelaySigner(JSON.stringify(jwk))
    expect(signer?.kid).toBe('test-1')
    const token = await mintRelayToken(signer!, { root: `nests/30312:${HOST}:abc123`, get: [''], put: [SPEAKER] }, NOW)
    const jwks = relayJwks(signer!)
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', kid: 'test-1', alg: 'ES256', use: 'sig' })
    expect(jwks.keys[0]?.d).toBeUndefined()
    const { payload, protectedHeader } = await jwtVerify(token, pair.publicKey, { currentDate: new Date(NOW * 1000 + 1000) })
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'test-1' })
    expect(payload).toMatchObject({ root: `nests/30312:${HOST}:abc123`, get: [''], put: [SPEAKER], iat: NOW, exp: NOW + 600 })
  })

  it('needs a private P-256 key and is absent when unconfigured', async () => {
    expect(await loadRelaySigner(undefined)).toBeUndefined()
    expect(await loadRelaySigner('  ')).toBeUndefined()
    await expect(loadRelaySigner(JSON.stringify({ kty: 'oct', k: 'x' }))).rejects.toThrow()
  })
})

describe('replay and the room cache', () => {
  it('admits an auth event once inside two minutes', () => {
    const guard = new ReplayGuard()
    expect(guard.admit('a', 0)).toBe(true)
    expect(guard.admit('a', 60_000)).toBe(false)
    expect(guard.admit('b', 60_000)).toBe(true)
    expect(guard.admit('a', 121_000)).toBe(true)
  })

  it('asks the relays once per half minute per room, and briefly remembers a miss', async () => {
    let asked = 0
    const cache = new RoomCache(async address => {
      asked += 1
      return address.endsWith('abc123') ? room('live') : undefined
    })
    await cache.get(`30312:${HOST}:abc123`, 0)
    await cache.get(`30312:${HOST}:abc123`, 10_000)
    expect(asked).toBe(1)
    await cache.get(`30312:${HOST}:abc123`, 31_000)
    expect(asked).toBe(2)
    expect(await cache.get(`30312:${HOST}:nope`, 0)).toBeUndefined()
    await cache.get(`30312:${HOST}:nope`, 1_000)
    expect(asked).toBe(3)
    await cache.get(`30312:${HOST}:nope`, 6_000)
    expect(asked).toBe(4)
  })

  it('picks the newest revision of the right room from a relay answer', () => {
    const old = room('live', { created_at: NOW - 600 })
    const newer = room('ended', { created_at: NOW - 10 })
    const other = room('live', { created_at: NOW }, [], 'zzz')
    expect(newestRoomEvent(`30312:${HOST}:abc123`, [old, other, newer])).toBe(newer)
    expect(newestRoomEvent(`30312:${HOST}:abc123`, [other])).toBeUndefined()
  })
})
