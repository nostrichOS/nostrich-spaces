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
- **A p-tag is a role, not a seat.** A room names who MAY speak; only the host can take that back,
  and a speaker who leaves keeps their tag. So a named speaker or co-host is drawn on the stage only
  while they are present: a heartbeat in the last six minutes that is not a departure (below), and
  that says `onstage 1` or `publishing 1`, or that is older than the room's newest revision (they
  were promoted and their client has not answered yet). Anybody the relay is carrying a broadcast
  from is on the stage whatever their heartbeat says. The host is always drawn.
- **The host** is the `host` p-tag, else the author.
- **Counts** only when somebody published one. Never `0`.
- **Nothing is guessed.** A room with no page and no relay parses to a card with no button.

## Leaving: an optional `left` tag

EGG-04's last heartbeat (`publishing 0`, `onstage 0`) is still a fresh presence in the room, so a
reader following the spec alone keeps the leaver in the audience for six minutes. The last
heartbeat this library sends (`buildDeparture`) is the spec's, with every flag at `0` (a raised hand
too), plus one tag:

```json
["left", "1"]
```

A reader that knows the tag takes the person out of the room the moment it arrives; one that does
not sees an ordinary off-stage heartbeat, so nothing breaks for anybody. Two rules make it
reliable:

- **Stamp every heartbeat at least a second after the one before it.** Kind 10312 is replaceable,
  and two in one second are settled by id, so a departure can lose to the beat it replaces. A
  departure sent while switching rooms must also be older than the new room's first beat.
- **Keep one heartbeat per person, the newest, whichever room it names** (EGG-04 rule 11), and keep
  a departure until it goes stale, so a slower relay's older copy cannot put the person back.

## Speaking: one channel, 48 kHz

EGG-03 says Opus, 48 kHz, mono, and a speaker must mean it: both halves fail silently. `@moq/publish`
builds its encoder from the microphone track's `getSettings()`, and browsers disagree about what
those say:

- **Channels.** WebKit (Safari, every iPhone) reports no `channelCount`; the library then builds a
  stereo encoder, feeds it a mono microphone, fails the first frame and resets the track. The
  speaker's own screen shows a working mic; listeners get nothing.
- **Rate.** A microphone running at 44.1 kHz (common on Windows and on USB microphones) is encoded
  at 44.1 kHz. Chrome and WebKit both encode that without complaint and neither can decode it, and
  `AudioDecoder.isConfigSupported` says yes to it all the same.

`opusSource` makes the settings the library reads say one channel at 48 kHz; the browser resamples
the microphone into the 48 kHz capture context (checked in Chrome and WebKit). A listener can tell
from the catalog: `numberOfChannels` other than `1` or a `sampleRate` other than `48000` is a
speaker nobody can hear. Test a speaker with a listener that DECODES: a byte counter passes both
failures, because the stream is on the wire and simply cannot be played.

`RoomSpeaker.switchTo(device)` changes the microphone mid-broadcast: the new input is opened first,
a refusal keeps the current one broadcasting, mute carries over, and listeners re-subscribe within a
second, as they do after an unmute.

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
