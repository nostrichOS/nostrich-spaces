# Hosting rooms

A host runs two things: a **relay** the audio goes through, and a **token service** that turns a
NIP-98 signature into a relay session. Rooms you publish carry both URLs, and every client on
the protocol joins them directly. A client that only wants to *join* rooms needs none of this.

## 1. DNS and TLS

- A hostname for the relay, e.g. `relay.example.org`, as a **DNS-only** record. WebTransport is
  QUIC on UDP and cannot go through a CDN proxy; the record has to point at the machine.
- A certificate from a public CA. `certbot certonly --nginx -d relay.example.org` (or the DNS
  challenge) works; the relay reads the files and picks up renewals.

## 2. Firewall and kernel

```
ufw allow 4443/udp
ufw allow 4443/tcp
sysctl -w net.core.rmem_max=8388608 net.core.wmem_max=8388608   # the relay asks for 8 MiB buffers
```

## 3. Keys

```
node scripts/keygen.mjs infra/public.jwk ./private.jwk
```

Mount `public.jwk` into the relay container; put the contents of `private.jwk` in the token
service's environment as `MOQ_AUTH_PRIVATE_JWK` and delete the file. The public half can be
committed; the private half never.

## 4. The relay

`infra/relay.toml.example` and `infra/docker-compose.example.yml`, edited for your hostname.
`kixelated/moq-relay` 0.10.15 is the version this library is tested against; newer relays
speak a newer draft of the wire and the pinned client libraries may not follow.

## 5. The token service

`createTokenService` in `src/auth/handler.ts` gives you two handlers on the standard `Request`
and `Response`. `examples/next-route.ts` wires them into Next.js; any runtime with `fetch`
works the same way. Serve them at a base you choose — `https://your.host/api/moq` — and publish
rooms with `["auth", "https://your.host/api/moq"]` and `["streaming", "https://relay.example.org:4443"]`.

The service must answer any origin (it does, `access-control-allow-origin: *`): other clients'
web apps fetch tokens for your rooms from their own pages.

## Capacity, measured

On a 12-core box with a 1 Gbit link (2026-09-09, one speaker at 32 kbit/s Opus, decode-free
listeners from a second machine):

| Listeners | Relay CPU | Relay out | Each heard |
|---|---|---|---|
| 100 | 35 % of one core | 9 Mbit/s | 34 kbit/s |
| 200 | 59 % | 18 Mbit/s | 34 kbit/s |
| 400 | 108 % | 34 Mbit/s | 33 kbit/s |

About 0.27 % of one core and 84 kbit/s on the wire per listener **per open microphone**; every
listener pulls every mic that is publishing, so five people talking at once costs five times
this. Budget four cores and a room with one open mic holds roughly 1,500 listeners. Past that
the answer is a second relay, not a bigger one.
