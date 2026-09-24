import { describe, expect, it } from 'vitest'

import { parsePresence } from './presence-event'
import {
  ADMIN_COMMAND_KIND,
  PRESENCE_IDENTIFIER,
  PRESENCE_OFF,
  ROOM_IDENTIFIER_PATTERN,
  buildAdminCommand,
  buildDeparture,
  buildPresence,
  buildRoom,
  buildRoomReaction,
  newRoomIdentifier,
  roomNamespace,
} from './room-builders'
import { spaceFrom } from './space'
import type { NostrEvent } from '../core/types'

/**
 * The shapes here are the audio-room protocol's (another client's EGG-01/04/06/07 specs), because that is
 * what makes a Nostrich room joinable from another client and the reference service. Each assertion is a
 * tag another client reads; the round trip through `spaceFrom` is our own reader.
 */

const NOW = 1_789_000_000
const HOST = 'a1'.repeat(32)
const ADMIN = 'b2'.repeat(32)
const SPEAKER = 'c3'.repeat(32)
const RELAYS = ['wss://relay-2.example.com', 'wss://relay-1.example.com']

const room = (over: Partial<Parameters<typeof buildRoom>[0]> = {}) =>
  buildRoom(
    {
      identifier: 'abc123',
      title: '  Morning   coffee ',
      summary: 'Talk about nothing',
      status: 'live',
      streaming: 'https://moq.nostrich.org:4443',
      auth: 'https://nostrich.org/api/moq',
      service: 'https://nostrich.org/spaces/naddr1xyz',
      relays: RELAYS,
      host: HOST.toUpperCase(),
      admins: [ADMIN],
      speakers: [SPEAKER, ADMIN, HOST],
      hashtags: ['#Bitcoin', 'nostr', 'bitcoin', ''],
      ...over,
    },
    { createdAt: NOW },
  )

const tag = (template: { tags: string[][] }, name: string): string[] | undefined => template.tags.find(t => t[0] === name)
const tags = (template: { tags: string[][] }, name: string): string[][] => template.tags.filter(t => t[0] === name)

describe('buildRoom', () => {
  it('writes the EGG-01 tags with both generations of the name, one relays tag and the host first', () => {
    const t = room()
    expect(t.kind).toBe(30312)
    expect(t.content).toBe('')
    expect(t.created_at).toBe(NOW)
    expect(tag(t, 'd')).toEqual(['d', 'abc123'])
    expect(tag(t, 'title')).toEqual(['title', 'Morning coffee'])
    expect(tag(t, 'room')).toEqual(['room', 'Morning coffee'])
    expect(tag(t, 'summary')).toEqual(['summary', 'Talk about nothing'])
    expect(tag(t, 'status')).toEqual(['status', 'live'])
    expect(tag(t, 'streaming')).toEqual(['streaming', 'https://moq.nostrich.org:4443'])
    expect(tag(t, 'auth')).toEqual(['auth', 'https://nostrich.org/api/moq'])
    expect(tag(t, 'service')).toEqual(['service', 'https://nostrich.org/spaces/naddr1xyz'])
    expect(tags(t, 'relays')).toEqual([['relays', ...RELAYS]])
    expect(tags(t, 'p')[0]).toEqual(['p', HOST, RELAYS[0], 'host'])
  })

  it('keeps one p tag per person at their highest role', () => {
    const p = tags(room(), 'p')
    expect(p).toEqual([
      ['p', HOST, RELAYS[0], 'host'],
      ['p', ADMIN, RELAYS[0], 'admin'],
      ['p', SPEAKER, RELAYS[0], 'speaker'],
    ])
  })

  it('lower-cases and dedupes hashtags, and writes starts/ends only when given', () => {
    expect(tags(room(), 't')).toEqual([['t', 'bitcoin'], ['t', 'nostr']])
    expect(tag(room(), 'starts')).toBeUndefined()
    const planned = room({ status: 'planned', startsAt: NOW + 3600.9 })
    expect(tag(planned, 'starts')).toEqual(['starts', String(NOW + 3600)])
    const ended = room({ status: 'ended', endsAt: NOW })
    expect(tag(ended, 'ends')).toEqual(['ends', String(NOW)])
  })

  it('refuses an identifier the relay namespace could not carry', () => {
    expect(() => room({ identifier: 'has:colon' })).toThrow()
    expect(() => room({ identifier: 'has space' })).toThrow()
    expect(() => room({ identifier: '' })).toThrow()
    expect(ROOM_IDENTIFIER_PATTERN.test(newRoomIdentifier())).toBe(true)
    expect(newRoomIdentifier()).not.toBe(newRoomIdentifier())
  })

  it('round-trips through our own reader as a live Nostrich room with roles and a page', () => {
    const t = room()
    const event = { ...t, id: 'e'.repeat(64), pubkey: HOST, sig: '' } as NostrEvent
    const space = spaceFrom(event, NOW + 30)
    expect(space?.status).toBe('live')
    expect(space?.audio).toBe(true)
    expect(space?.title).toBe('Morning coffee')
    expect(space?.host).toBe(HOST)
    expect(space?.participants).toEqual([
      { pubkey: HOST, role: 'host' },
      { pubkey: ADMIN, role: 'cohost' },
      { pubkey: SPEAKER, role: 'speaker' },
    ])
    expect(space?.service).toEqual({ name: 'Nostrich', host: 'nostrich.org', joinUrl: 'https://nostrich.org/spaces/naddr1xyz' })
    expect(space?.stream).toBe('https://moq.nostrich.org:4443')
    expect(space?.auth).toBe('https://nostrich.org/api/moq')
    expect(space?.relays).toEqual(RELAYS)
    expect(space?.hashtags).toEqual(['bitcoin', 'nostr'])
    expect(roomNamespace(space!.address)).toBe(`nests/30312:${HOST}:abc123`)
  })

  it('a planned room reads as planned until it starts; an ended one as ended', () => {
    const planned = { ...room({ status: 'planned', startsAt: NOW + 7200 }), id: 'e'.repeat(64), pubkey: HOST, sig: '' } as NostrEvent
    expect(spaceFrom(planned, NOW)?.status).toBe('planned')
    const ended = { ...room({ status: 'ended', endsAt: NOW }), id: 'e'.repeat(64), pubkey: HOST, sig: '' } as NostrEvent
    expect(spaceFrom(ended, NOW + 10)?.status).toBe('ended')
  })
})

describe('buildPresence', () => {
  it('writes every EGG-04 flag as a string, the fixed d, and the room with its hint', () => {
    const t = buildPresence(`30312:${HOST}:abc123`, { hand: true, muted: false, publishing: true, onstage: true }, { relay: 'wss://relay-1.example.com', createdAt: NOW })
    expect(t.kind).toBe(10312)
    expect(t.tags).toEqual([
      ['d', PRESENCE_IDENTIFIER],
      ['a', `30312:${HOST}:abc123`, 'wss://relay-1.example.com'],
      ['hand', '1'],
      ['muted', '0'],
      ['publishing', '1'],
      ['onstage', '1'],
      ['alt', 'Room Presence tag'],
    ])
  })

  it('is read back by our parser, flags and all', () => {
    const t = buildPresence(`30312:${HOST}:abc123`, PRESENCE_OFF, { createdAt: NOW })
    const parsed = parsePresence({ ...t, id: 'e'.repeat(64), pubkey: SPEAKER, sig: '' } as NostrEvent)
    expect(parsed).toEqual({
      pubkey: SPEAKER,
      room: `30312:${HOST}:abc123`,
      handRaised: false,
      muted: false,
      publishing: false,
      onstage: false,
      left: false,
      at: NOW,
    })
  })
})

describe('buildDeparture', () => {
  it('is the spec’s last beat, every flag off, plus the one tag that says the person has gone', () => {
    const t = buildDeparture(`30312:${HOST}:abc123`, { relay: 'wss://relay-1.example.com', createdAt: NOW })
    expect(t.kind).toBe(10312)
    expect(t.tags).toEqual([
      ['d', PRESENCE_IDENTIFIER],
      ['a', `30312:${HOST}:abc123`, 'wss://relay-1.example.com'],
      ['hand', '0'],
      ['muted', '0'],
      ['publishing', '0'],
      ['onstage', '0'],
      ['alt', 'Room Presence tag'],
      ['left', '1'],
    ])
    const parsed = parsePresence({ ...t, id: 'e'.repeat(64), pubkey: SPEAKER, sig: '' } as NostrEvent)
    expect(parsed).toMatchObject({ room: `30312:${HOST}:abc123`, handRaised: false, onstage: false, left: true, at: NOW })
  })
})

describe('buildAdminCommand', () => {
  it('is an ephemeral 4312 naming the room, the target and the verb', () => {
    const t = buildAdminCommand(`30312:${HOST}:abc123`, SPEAKER.toUpperCase(), 'kick', { relay: 'wss://relay-1.example.com', createdAt: NOW })
    expect(t.kind).toBe(ADMIN_COMMAND_KIND)
    expect(t.content).toBe('')
    expect(t.tags).toEqual([
      ['a', `30312:${HOST}:abc123`, 'wss://relay-1.example.com'],
      ['p', SPEAKER],
      ['action', 'kick'],
      ['alt', 'Audio room admin command'],
    ])
  })
})

describe('buildRoomReaction', () => {
  it('aims a kind 7 at the room, and at one speaker when asked', () => {
    const wide = buildRoomReaction(`30312:${HOST}:abc123`, '👏', { createdAt: NOW })
    expect(wide.kind).toBe(7)
    expect(wide.content).toBe('👏')
    expect(wide.tags).toEqual([['a', `30312:${HOST}:abc123`], ['k', '30312']])
    const aimed = buildRoomReaction(`30312:${HOST}:abc123`, '❤️', { target: SPEAKER, relay: 'wss://relay-1.example.com', createdAt: NOW })
    expect(aimed.tags).toEqual([['a', `30312:${HOST}:abc123`, 'wss://relay-1.example.com'], ['k', '30312'], ['p', SPEAKER]])
  })

  it('carries a custom emoji the NIP-30 way', () => {
    const t = buildRoomReaction(`30312:${HOST}:abc123`, 'x', { emoji: { shortcode: 'clap', url: 'https://x/clap.png' }, createdAt: NOW })
    expect(t.content).toBe(':clap:')
    expect(t.tags).toContainEqual(['emoji', 'clap', 'https://x/clap.png'])
  })
})
