/**
 * JOIN A ROOM AND LISTEN — the whole client side, in a browser.
 *
 * Nothing here talks to Nostrich. The room event says where its audio is (`streaming`) and who
 * mints sessions for it (`auth`); the listener asks that service for a token with a throwaway
 * key, connects to that relay, and decodes whoever is publishing. Works for any room on the
 * audio-room protocol, whichever client hosts it.
 */
import { RoomListener, roomWire, spaceFrom, type NostrEvent } from '../src/index'

export async function listen(roomEvent: NostrEvent, onStatus: (status: string) => void): Promise<() => void> {
  const space = spaceFrom(roomEvent, Math.floor(Date.now() / 1000))
  if (space === undefined) throw new Error('not a room this library lists')
  const room = roomWire(space)
  if (room === undefined) throw new Error('this room does not carry a MoQ relay')

  const listener = new RoomListener(room)
  const stop = listener.onChange(state => onStatus(`${state.status} · ${state.speakers.length} speaking · ${state.bytes} bytes`))
  await listener.start()
  return () => {
    stop()
    listener.stop()
  }
}
