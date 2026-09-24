import { describe, expect, it } from 'vitest'

import { parsePresence } from './presence-event'
import type { NostrEvent } from '../core/types'

const LISTENER = 'a'.repeat(64)
const ROOM = '30312:' + 'b'.repeat(64) + ':1c102627-2578-473a-9bd4-f2813ed2cae0'

const event = (tags: string[][]): NostrEvent =>
  ({
    id: 'e'.repeat(64),
    pubkey: LISTENER,
    kind: 10312,
    created_at: 1_788_900_000,
    content: '',
    sig: '',
    tags,
  }) as NostrEvent

describe('parsePresence', () => {
  it('reads the room, the raised hand and the heartbeat time', () => {
    const presence = parsePresence(event([['a', ROOM, 'wss://relay.example.com', 'root'], ['hand', '1']]))
    expect(presence.pubkey).toBe(LISTENER)
    expect(presence.room).toBe(ROOM)
    expect(presence.handRaised).toBe(true)
    expect(presence.at).toBe(1_788_900_000)
  })

  it('leaves the microphone state unknown when the client did not say', () => {
    expect(parsePresence(event([['a', ROOM]])).muted).toBeUndefined()
    expect(parsePresence(event([['a', ROOM], ['muted', '1']])).muted).toBe(true)
    expect(parsePresence(event([['a', ROOM], ['muted', '0']])).muted).toBe(false)
  })

  it('reads a departure only from our `left` tag, never from flags that happen to be off', () => {
    expect(parsePresence(event([['a', ROOM], ['hand', '0'], ['muted', '0'], ['publishing', '0'], ['onstage', '0']])).left).toBe(false)
    expect(parsePresence(event([['a', ROOM], ['onstage', '0'], ['left', '1']])).left).toBe(true)
  })

  it('drops a room tag that is not an address', () => {
    expect(parsePresence(event([['a', 'not-an-address']])).room).toBeUndefined()
    expect(parsePresence(event([])).room).toBeUndefined()
  })
})
