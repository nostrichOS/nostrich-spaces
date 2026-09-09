# The wire protocol, on one page

A Space is a set of ordinary Nostr events plus one audio stream. Every client that can read the
events can list the room; every client that speaks the audio wire can join it. Nothing is
proxied through the host's client, and no server holds anything private.

## The events

| Kind | What it is | Who writes it |
|---|---|---|
| `30312` | **The room.** Addressable. `d` identifier, `title` and `room`, `status live \| planned \| ended`, `streaming` (the MoQ relay), `auth` (the token service), `service` (a web page for the room), one `relays` tag, `p` tags with roles, `t` hashtags, `starts` / `ends`. | The host, and only the host. Republished on every change: a promotion is a new revision with one more `p` tag. |
| `30313` | **A scheduled meeting** in a room (`a` names the room). | The host. Believed for one hour after its timestamp. |
| `10312` | **A heartbeat.** Replaceable, fixed `d nests-room-presence`, `a` names the room, four `0/1` flags: `hand`, `muted`, `publishing`, `onstage`. Every 30 s ± 5 s while in a room; at once when a flag changes; a final `publishing 0 onstage 0` on leaving. | Everyone in the room with a key. |
| `1311` | **Chat.** `a` names the room. | Anyone. |
| `7` | **A reaction** with `a` (and `p` for one aimed at a person). | Anyone. |
| `4312` | **Moderation.** `kick` or `mute`, from the host or an admin, `p` names the target. | Host and admins. |

Roles on a `p` tag: `host`, `admin` (a co-host), `speaker`. Anything else, or no tag, is a
listener. `normalizeRole` reads both generations of the vocabulary.

## The rules this library applies

- **Freshness.** `status: live` is believed for eight hours after the event's timestamp, a
  meeting for one. Rooms opened months ago still say `live` on relays; of 52 saying so when we
  measured, three were.
- **On stage.** A live room older than ten minutes is only listed while somebody's heartbeat in
  the last ten minutes says `onstage 1`. other implementations apply the same rule; a host who closed the
  tab without ending the room otherwise leaves it saying `live` for hours.
- **The host** is the `host` p-tag, else the author.
- **Counts** only when somebody published one. Never `0`.
- **Nothing is guessed.** A room with no page and no relay parses to a card with no button.

## The audio wire (audio-room protocol, EGG-01 … EGG-12)

1. **Token.** `POST <auth>/auth` with body `{"namespace": "nests/30312:<host>:<d>", "publish": false | true}`,
   signed as a NIP-98 event over that URL. The answer is `{"token": "<JWT>"}`, ES256, ten
   minutes: `{ root: "<namespace>", get: [""], put: ["<pubkey>"] | [], iat, exp: iat + 600 }`.
   The service checks the room's newest event: a listener token for anyone while the room is
   live, a publishing token only for the host and the `speaker` / `admin` p-tags, nothing for a
   planned or ended room. The public key is served at `<auth>/.well-known/jwks.json`.
2. **Connect.** WebTransport to `<streaming>/<namespace>?jwt=<token>`; WebSocket on the same
   port when the browser has no WebTransport. moq-lite drafts 01 to 06.
3. **Broadcasts.** One per speaker, named by their hex pubkey under the room's root. Each
   carries a `catalog.json` and an `audio/data` track: Opus, 48 kHz, mono, 20 ms frames, one
   packet per frame. Mute is "stop publishing", never silence frames.
4. **Presence** rides on Nostr, not on the relay: the relay knows nothing about who is
   listening, so a listener with no key is invisible and a listener with one is a heartbeat.

The EGG specifications were published with the audio-room protocol's reference implementation. This
library follows them as they stood on 2026-09-09 and is exercised against two other
implementations of the same wire.
