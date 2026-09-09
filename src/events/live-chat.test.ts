import { describe, expect, it } from 'vitest'

import { LIVE_CHAT_KIND, buildLiveChatMessage, parseLiveChat } from './live-chat'
import type { NostrEvent } from '../core/types'

const WRITER = 'ab'.padEnd(64, 'c')
const ROOM = `30312:${'d'.repeat(64)}:lounge`

const event = (tags: string[][], kind = LIVE_CHAT_KIND): NostrEvent =>
  ({ id: 'e'.repeat(64), pubkey: WRITER, kind, created_at: 1_788_900_000, content: 'gm', sig: '', tags }) as NostrEvent

describe('parseLiveChat', () => {
  it('reads the room, the words and the reply mark', () => {
    const message = parseLiveChat(event([['a', ROOM, 'wss://relay.example'], ['e', 'f'.repeat(64)]]))
    expect(message).toMatchObject({ address: ROOM, content: 'gm', pubkey: WRITER, replyTo: 'f'.repeat(64) })
  })

  it('refuses a message with no activity, or of another kind', () => {
    expect(parseLiveChat(event([]))).toBeUndefined()
    expect(parseLiveChat(event([['a', 'nope']]))).toBeUndefined()
    expect(parseLiveChat(event([['a', ROOM]], 1))).toBeUndefined()
  })
})

describe('buildLiveChatMessage', () => {
  it('names the activity with its relay, and the message it answers', () => {
    const template = buildLiveChatMessage(ROOM, 'hello', { relay: 'wss://relay-1.example.com' as never, replyTo: 'f'.repeat(64) as never, createdAt: 5 })
    expect(template).toEqual({ kind: 1311, content: 'hello', tags: [['a', ROOM, 'wss://relay-1.example.com'], ['e', 'f'.repeat(64)]], created_at: 5 })
  })

  it('stamps now when no time is given', () => {
    expect(buildLiveChatMessage(ROOM, 'x').created_at).toBeGreaterThan(1_700_000_000)
  })
})
