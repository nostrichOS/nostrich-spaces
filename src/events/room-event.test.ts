import { describe, expect, it } from 'vitest'

import { isMeetingShaped, parseMeeting } from './meeting-event'
import { parseRoom } from './room-event'
import type { NostrEvent } from '../core/types'

const OWNER = 'b78dfdcefc1de9f08ffe591a2d42b3634733bc714e822ddd104d604b7e0121f2'

const event = (kind: number, tags: string[][]): NostrEvent =>
  ({
    id: 'e'.repeat(64),
    pubkey: OWNER,
    kind,
    created_at: 1_788_900_000,
    content: '',
    sig: '',
    tags,
  }) as NostrEvent

describe('parseRoom', () => {
  it('reads `room` before `title` for the name, and keeps the status as written', () => {
    const room = parseRoom(event(30312, [['d', 'x'], ['room', 'Lounge'], ['title', 'Other'], ['status', 'Open']]))
    expect(room.name).toBe('Lounge')
    expect(room.status).toBe('open')
  })

  it('reads the `relays` tag as one tag with many values', () => {
    const room = parseRoom(event(30312, [['d', 'x'], ['relays', 'wss://a.example', 'wss://b.example', '']]))
    expect(room.relays).toEqual(['wss://a.example', 'wss://b.example'])
  })

  it('keeps participants with their roles as written and drops malformed pubkeys', () => {
    const room = parseRoom(event(30312, [['d', 'x'], ['p', OWNER, '', 'Host'], ['p', 'nope', '', 'Speaker'], ['p', OWNER.toUpperCase(), '', 'speaker']]))
    expect(room.participants).toEqual([
      { pubkey: OWNER, role: 'Host' },
      { pubkey: OWNER, role: 'speaker' },
    ])
  })

  it('treats a zero timestamp as absent', () => {
    expect(parseRoom(event(30312, [['d', 'x'], ['starts', '0']])).starts).toBeUndefined()
    expect(parseRoom(event(30312, [['d', 'x'], ['starts', '1788799555']])).starts).toBe(1788799555)
  })
})

describe('parseMeeting', () => {
  it('reads the parent room address and the counts', () => {
    const meeting = parseMeeting(event(30313, [['d', 'm'], ['a', '30312:' + OWNER + ':r'], ['title', 'Monthly'], ['status', 'planned'], ['total_participants', '12']]))
    expect(meeting.room).toBe('30312:' + OWNER + ':r')
    expect(meeting.title).toBe('Monthly')
    expect(meeting.totalParticipants).toBe(12)
    expect(meeting.currentParticipants).toBeUndefined()
  })

  it('recognises a meeting by its title or its room, and nothing else', () => {
    expect(isMeetingShaped(event(30313, [['d', 'm'], ['title', 'x']]))).toBe(true)
    expect(isMeetingShaped(event(30313, [['d', 'm'], ['a', '30312:' + OWNER + ':r']]))).toBe(true)
    expect(isMeetingShaped(event(30313, [['d', 'm'], ['oracle', 'x'], ['prices_hash', 'y']]))).toBe(false)
    expect(isMeetingShaped(event(30312, [['d', 'm'], ['title', 'x']]))).toBe(false)
  })
})
