# Joining rooms

Everything a client needs to list, join and speak in rooms, with no infrastructure of its own.

## List

Subscribe to kinds `30312`, `30313` and `10312` on your relays and feed each event to
`spaceFrom(event, now)`. It returns a `Space` — title, status, host, participants, page, relay,
auth service, hashtags — or `undefined` for anything that should not be listed. Keep the newest
revision per address; count a person present from their newest heartbeat within six minutes.

## Listen

```ts
import { RoomListener, roomWire, spaceFrom } from 'nostrich-spaces'

const space = spaceFrom(event, now)!
const room = roomWire(space)!            // undefined when the room has no MoQ relay
const listener = new RoomListener(room)
listener.onChange(state => console.log(state.status, state.speakers))
await listener.start()                    // anonymous: a throwaway key signs the token request
```

`RoomListener` mints a token from the room's own `auth` service, connects to the room's own
`streaming` relay (WebTransport, WebSocket fallback), and decodes one Opus stream per speaker
into the page's audio output. `state.bytesBy` tells you who is talking.

## Speak

```ts
const listener = new RoomListener(room)
await listener.start(mySigner, { publish: true })   // a publishing token, for the host or a p-tagged speaker
const speaker = new RoomSpeaker()
await speaker.start(listener, myPubkey)              // asks for the microphone, publishes Opus
speaker.setMuted(true)                               // stops publishing; never sends silence
```

Publishing is refused by the token service unless the requester is the room's host or is named
`speaker` or `admin` on its newest event. Being invited is the host republishing the room with
your `p` tag; nothing to do on your side but ask again for a token.

## Be present

Publish a `10312` heartbeat every 30 s ± 5 s with `buildPresence(address, flags, relay)` while
the user is in a room, at once when a flag changes, and a final `publishing 0 onstage 0` when
they leave. Do not do this for a NIP-46 remote signer without asking: it is a signing prompt
twice a minute.

## Browser floor

WebTransport (Safari 26.4+, Chrome, Firefox) with the relay's WebSocket fallback for older
Safari; WebCodecs Opus where the browser has it, the WASM codec the libraries ship where it
does not. An iOS web view is WebKit, so iOS 26 and up.
