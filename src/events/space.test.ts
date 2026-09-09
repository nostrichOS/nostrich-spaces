import { describe, expect, it } from 'vitest'

import { roomWire } from '../audio/room-wire'
import { spaceFrom } from './space'
import type { NostrEvent } from '../core/types'

/**
 * The rules, against events shaped like the ones on the network. Hosts are placeholders: the
 * rules are about tags, never about who wrote them.
 */
const HOST = 'a'.repeat(64)
const NOW = 1_800_000_000
const HOUR = 3600

function room(tags: string[][], created_at = NOW): NostrEvent {
  return { id: 'b'.repeat(64), pubkey: HOST, kind: 30312, created_at, content: '', sig: 'c'.repeat(128), tags }
}

const LIVE = [
  ['d', 'office-hours'],
  ['title', 'Office hours'],
  ['room', 'Office hours'],
  ['status', 'live'],
  ['streaming', 'https://relay.example.org:4443'],
  ['auth', 'https://rooms.example.org/api/moq'],
  ['service', 'https://rooms.example.org/spaces/office-hours'],
  ['relays', 'wss://relay-1.example.com', 'wss://relay-2.example.com'],
  ['p', HOST, 'wss://relay-1.example.com', 'host'],
  ['t', 'nostr'],
]

describe('spaceFrom', () => {
  it('reads a live room: title, host, page, relays, hashtags, the wire', () => {
    const space = spaceFrom(room(LIVE), NOW)
    expect(space?.status).toBe('live')
    expect(space?.title).toBe('Office hours')
    expect(space?.host).toBe(HOST)
    expect(space?.service.joinUrl).toBe('https://rooms.example.org/spaces/office-hours')
    expect(space?.relays).toEqual(['wss://relay-1.example.com', 'wss://relay-2.example.com'])
    expect(space?.hashtags).toEqual(['nostr'])
    expect(space?.stream).toBe('https://relay.example.org:4443')
    expect(space?.auth).toBe('https://rooms.example.org/api/moq')
  })

  it('believes `status: live` for eight hours, not forever', () => {
    expect(spaceFrom(room(LIVE, NOW - 7 * HOUR), NOW)?.status).toBe('live')
    expect(spaceFrom(room(LIVE, NOW - 9 * HOUR), NOW)?.status).not.toBe('live')
  })

  it('opens `service` only when it is a page, never an API base', () => {
    const api = LIVE.map(tag => (tag[0] === 'service' ? ['service', 'https://api.example.org/v1'] : tag))
    expect(spaceFrom(room(api), NOW)?.service.joinUrl).toBeUndefined()
  })

  it('takes the host from the host p-tag, else the author', () => {
    const other = 'd'.repeat(64)
    const hosted = LIVE.map(tag => (tag[0] === 'p' ? ['p', other, '', 'host'] : tag))
    expect(spaceFrom(room(hosted), NOW)?.host).toBe(other)
    const unhosted = LIVE.filter(tag => tag[0] !== 'p')
    expect(spaceFrom(room(unhosted), NOW)?.host).toBe(HOST)
  })
})

describe('roomWire', () => {
  it('names the relay, the token service and the namespace a token is minted for', () => {
    const wire = roomWire(spaceFrom(room(LIVE), NOW)!)
    expect(wire?.relay.href).toBe('https://relay.example.org:4443/')
    expect(wire?.auth).toBe('https://rooms.example.org/api/moq')
    expect(wire?.namespace).toBe(`nests/30312:${HOST}:office-hours`)
  })

  it('is nothing for a room that names no token service', () => {
    const silent = LIVE.filter(tag => tag[0] !== 'auth')
    expect(roomWire(spaceFrom(room(silent), NOW)!)).toBeUndefined()
  })
})
