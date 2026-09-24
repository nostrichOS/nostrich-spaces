<p align="center">
  <img src="./docs/mark.svg" width="72" height="72" alt="">
</p>

<h1 align="center">Nostrich Spaces</h1>

<p align="center"><strong>Live audio rooms on Nostr, open to every client.</strong></p>

<p align="center">
  <a href="./LICENSE">MIT</a> ·
  <a href="./docs/protocol.md">Protocol</a> ·
  <a href="./docs/joining.md">Joining</a> ·
  <a href="./docs/hosting.md">Hosting</a>
</p>

---

Spaces are the live rooms on [nostrich.org](https://nostrich.org): anyone starts one, invites
people to the stage, and anyone listens. This repository is the part of that feature which
belongs to the network rather than to us — the events, the audio transport and the token
service — packaged so that **any Nostr client can join a Space, and any client can host its
own, without routing a single byte through Nostrich.**

A room is a kind-30312 event. It carries two URLs: the relay its audio runs on and the service
that mints a session for it. Whoever hosts the room points those at their own infrastructure.
Every client reads them off the event and talks to that relay directly. That is the whole
design, and it is why a Space started on Nostrich shows up in other clients and their listeners
can join it, and why a room hosted elsewhere plays inside Nostrich.

```
                     kind 30312 (the room)
   host ───────────▶  streaming: https://relay.example.org:4443
                      auth:      https://rooms.example.org/api/moq
                      p: host · admin · speaker
                             │
      ┌──────────────────────┼────────────────────────┐
      ▼                      ▼                        ▼
  Nostrich           another client           a third client
      │  NIP-98 → JWT       │                         │
      └──────────────▶  token service  ◀──────────────┘
      │                      │
      └──────────────▶   moq relay    ◀───────────────┘
                     Opus over WebTransport, one broadcast per speaker
```

## Two ways in

**Join only.** Needs no infrastructure. Read rooms from relays, ask the room's own token service
for a session with a throwaway key, connect to the room's own relay, decode whoever is talking.
Speaking is the same with the user's real key, once the host has named them on the event.
→ [docs/joining.md](./docs/joining.md)

**Host too.** Run a relay ([kixelated/moq-relay](https://github.com/kixelated/moq)) and the token
service in this repository, on your own box. Publish rooms with your URLs. Every client on the
protocol joins them. → [docs/hosting.md](./docs/hosting.md)

## What is in the box

| Path | What it is |
|---|---|
| `src/events/` | Builders and parsers for kinds 30312, 30313, 10312, 1311, 7 and 4312, with the freshness, host and on-stage rules and their tests. `spaceFrom(event)` turns any event into a listable `Space` or nothing. |
| `src/audio/` | `RoomListener` and `RoomSpeaker`: the room's audio wire on `@moq/lite` 0.1.7, `@moq/watch` 0.2.3 and `@moq/publish` 0.2.3, pinned exactly because the relay speaks one draft of the protocol. A speaker is always encoded mono at 48 kHz, whatever the browser reports about its microphone, and can switch microphone mid-broadcast (`switchTo`); a listener never subscribes to its own broadcast. See [docs/protocol.md](./docs/protocol.md#speaking-one-channel-48-khz). |
| `src/auth/` | The token service: NIP-98 verification, the EGG-07 role check against the room's newest event, ES256 minting, the JWKS document, a replay guard. Two handlers on the standard `Request`/`Response`. |
| `scripts/keygen.mjs` | The relay key pair, once. |
| `infra/` | The relay's config and compose service, as templates. |
| `docs/` | The protocol on one page, joining, hosting, measured capacity. |
| `examples/` | A twenty-line listener, and the token service in a Next.js route. |

## Quick start

```sh
npm install nostrich-spaces        # or copy src/ into your tree; it is plain TypeScript
```

List rooms:

```ts
import { spaceFrom } from 'nostrich-spaces'

const space = spaceFrom(event, Math.floor(Date.now() / 1000))
if (space?.status === 'live') console.log(space.title, space.host, space.service.name)
```

Listen:

```ts
import { RoomListener, roomWire } from 'nostrich-spaces'

const listener = new RoomListener(roomWire(space)!)
await listener.start()          // anonymous by construction
```

Host a room:

```ts
import { buildRoom, buildPresence, newRoomIdentifier } from 'nostrich-spaces'

const room = buildRoom({
  identifier: newRoomIdentifier(),
  title: 'Office hours',
  status: 'live',
  streaming: 'https://relay.example.org:4443',
  auth: 'https://rooms.example.org/api/moq',
  service: 'https://rooms.example.org/spaces/…',
  relays: ['wss://relay-1.example.com', 'wss://relay-2.example.com'],
  host: myPubkey,
})
await publish(await signer.signEvent(room))
```

## Interoperability

The audio wire is the audio-room protocol, and it is not ours: two other implementations list,
listen, speak and host on it today, and a Space started on Nostrich appears in them the moment
its event reaches a relay. Anything that reads NIP-53 lists the room and links to its page,
whether or not it speaks the wire.

Rooms on other audio stacks (a WebRTC page behind a NIP-53 event) are listed by everyone and
played by nobody but their own site. The audio-room protocol is the one wire independent clients
already share; this library is one more implementation of it.

## The rules, because the network is messy

`status: live` means live for eight hours, then nothing. A live room older than ten minutes is
listed only while someone's heartbeat says they are on stage. A host is the `host` p-tag, else
the author. A count is shown only when somebody published one, never `0`. A room with no page
and no relay gets no button. Each rule is a test against real events, in `src/events/`.

## Capacity

Measured on one 12-core relay box: about 0.27 % of one core and 84 kbit/s per listener, per
open microphone. 400 listeners on one speaker used 1.1 cores and 34 Mbit/s with every listener
hearing clean audio. Numbers and method in [docs/hosting.md](./docs/hosting.md#capacity-measured).

## Specifications and credits

- [NIP-53](https://github.com/nostr-protocol/nips/blob/master/53.md) — live activities, rooms, meetings, presence, chat.
- The audio-room protocol, EGG-01 … EGG-12 — published with the reference implementation; [docs/protocol.md](./docs/protocol.md) is the part this library implements, on one page.
- [moq](https://github.com/kixelated/moq) by kixelated — the relay and the browser libraries.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for the full text.
