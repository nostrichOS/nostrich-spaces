import { ROOM_KIND } from '../events/room-event'
import type { Space } from '../events/space'

/**
 * Whether a space is a protocol room we can listen to natively, and what its transport needs.
 *
 * Pure and dependency-free on purpose: the listen-mode rule asks this question for every
 * live room on every page, and the MoQ library that actually speaks to the relay is loaded
 * only when somebody presses Listen — see `wire.ts`.
 */



export interface RoomWire {
  relay: URL
  auth: string
  /** `nests/<address>` — the relay path and the token's scope. */
  namespace: string
}

export function roomWire(space: Space): RoomWire | undefined {
  if (space.kind !== ROOM_KIND || space.stream === undefined) return undefined
  let relay: URL
  try {
    relay = new URL(space.stream)
  } catch {
    return undefined
  }
  if (relay.protocol !== 'https:') return undefined
  // A MoQ relay, not a page: the room names it in `streaming` and its token service in `auth`.
  if (space.auth === undefined) return undefined
  return { relay, auth: space.auth, namespace: `nests/${space.address}` }
}
