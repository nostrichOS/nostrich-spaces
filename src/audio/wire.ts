'use client'

import type * as Moq from '@moq/lite'
import type * as Publish from '@moq/publish'
import type * as Watch from '@moq/watch'
import { createHttpAuth, httpAuthHeader } from '../core/http-auth'
import { PrivateKeySigner } from '../core/private-key-signer'
import type { Hex, Signer } from '../core/types'

import type { RoomWire } from './room-wire'


export { roomWire, type RoomWire } from './room-wire'

/**
 * LISTENING TO A PROTOCOL ROOM, natively.
 *
 * the protocol refuses to be framed and publishes no page we could play, but its audio has a public
 * wire: MoQ over WebTransport, with a token minted by a NIP-98-signed request. This is the
 * reference client's transport (the reference implementation) reduced to the
 * listening half, on the library generation it pins: `@moq/watch` 0.2.3 over `@moq/lite`
 * 0.1.7. Pinned exactly, because the relay speaks one draft of the wire and the newer
 * packages speak another and changed the announcement API besides.
 *
 * ── The flow ─────────────────────────────────────────────────────────────────────────
 *
 *  1. POST <auth>/auth {namespace: "nests/<address>", publish: false}, signed NIP-98
 *     → {token}. The room's `auth` tag names the service; the protocol' own is the fallback.
 *  2. WebTransport to <relay>/<namespace>?jwt=<token>, WebSocket when the browser has no
 *     WebTransport (the library falls back by itself).
 *  3. The relay announces one broadcast per speaker, named by their pubkey. Each becomes a
 *     Watch.Broadcast → Sync → Audio.Source → Decoder → Emitter, which is the speaker.
 *
 * ── Anonymous by construction ────────────────────────────────────────────────────────
 *
 * The token request is signed by a key made for the occasion and thrown away. A listener
 * publishes nothing and appears in no roster; the reader's own key is never asked to sign a
 * request to somebody else's server for the privilege of hearing them. X's "listen
 * anonymously" switch, with no switch.
 *
 * ── Loaded on Listen, never on a page ───────────────────────────────────────────────
 *
 * The transport and the codecs are a few hundred kilobytes nobody reading a timeline asked
 * for, so they arrive with the first press and the types here are types only.
 */

/** Twenty seconds of nothing from the relay is a relay that is not coming. */
const CONNECT_TIMEOUT_MS = 20_000

/** The jitter buffer. Generous, as the reference client's: an underrun is worse than a delay. */
const LATENCY_MS = 150

/**
 * The token: `POST <auth>/auth {namespace, publish}`, signed as NIP-98 for the service's URL and
 * sent once — a token service refuses a reused auth event.
 */
export async function roomToken(room: RoomWire, signer: Signer, publish = false): Promise<string> {
  const url = `${room.auth.replace(/\/$/, '')}/auth`
  const body = JSON.stringify({ namespace: room.namespace, publish })
  // The content line makes two requests in the same second two different events; a token
  // service refuses a reused auth event, and ours would otherwise see one on a quick retry.
  const auth = await createHttpAuth(signer, { url, method: 'POST', content: `${publish ? 'Speak in' : 'Listen to'} a protocol room ${Date.now()}` })
  const headers = { 'content-type': 'application/json', authorization: httpAuthHeader(auth) }
  const response = await fetch(url, { method: 'POST', headers, body })
  if (!response.ok) throw new Error(`moq-auth answered ${response.status}`)
  const data = (await response.json()) as { token?: unknown }
  if (typeof data.token !== 'string' || data.token === '') throw new Error('moq-auth returned no token')
  return data.token
}

export type ListenerStatus = 'idle' | 'authorising' | 'connecting' | 'connected' | 'disconnected' | 'failed'

export interface ListenerState {
  status: ListenerStatus
  /** Pubkeys currently broadcasting audio, in the order they were heard. */
  speakers: readonly Hex[]
  /** Encoded audio bytes received across every speaker: the proof that sound is arriving. */
  bytes: number
  /** The same per speaker, so a view can tell who is talking by watching the count move. */
  bytesBy: ReadonlyMap<Hex, number>
  error: string | undefined
}

interface SpeakerPipeline {
  broadcast: Watch.Broadcast
  sync: Watch.Sync
  source: Watch.Audio.Source
  decoder: Watch.Audio.Decoder
  emitter: Watch.Audio.Emitter
  stopStats: () => void
}

async function libraries(): Promise<{ moq: typeof Moq; watch: typeof Watch }> {
  const [moq, watch] = await Promise.all([import('@moq/lite'), import('@moq/watch')])
  return { moq, watch }
}

/** One room, from token to speakers. `stop()` tears everything down; nothing outlives it. */
export class RoomListener {
  private moq: typeof Moq | undefined
  private watch: typeof Watch | undefined
  private connection: Moq.Connection.Reload | undefined
  private readonly speakers = new Map<Hex, SpeakerPipeline>()
  private readonly bytes = new Map<Hex, number>()
  private readonly listeners = new Set<(state: ListenerState) => void>()
  private readonly disposers: Array<() => void> = []
  private state: ListenerState = { status: 'idle', speakers: [], bytes: 0, bytesBy: new Map(), error: undefined }
  private volume = 1
  private stopped = false

  constructor(private readonly room: RoomWire) {}

  get current(): ListenerState {
    return this.state
  }

  onChange(listener: (state: ListenerState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Connect and listen. `signer` is optional: without one, a throwaway key signs the token
   * request. `publish` asks for a token that may also broadcast — the reader's OWN key then,
   * because the relay grants `put` to the pubkey the room's event names, and a speaker's
   * broadcast is named by that same pubkey (EGG-03).
   */
  async start(signer: Signer = PrivateKeySigner.generate(), options: { publish?: boolean } = {}): Promise<void> {
    this.set({ status: 'authorising' })
    let token: string
    try {
      const [loaded, minted] = await Promise.all([libraries(), roomToken(this.room, signer, options.publish === true)])
      this.moq = loaded.moq
      this.watch = loaded.watch
      token = minted
    } catch (err) {
      this.set({ status: 'failed', error: err instanceof Error ? err.message : 'could not get a token' })
      return
    }
    if (this.stopped) return
    const moq = this.moq
    if (moq === undefined) return

    const url = new URL(this.room.relay.toString())
    url.pathname = `/${this.room.namespace}`
    url.searchParams.set('jwt', token)
    this.set({ status: 'connecting' })

    const connection = new moq.Connection.Reload({
      url,
      enabled: true,
      delay: { initial: 1000, multiplier: 2, max: 30_000 },
      webtransport: {},
      websocket: {},
    })
    this.connection = connection

    const timeout = setTimeout(() => {
      if (this.state.status === 'connecting') this.set({ status: 'failed', error: 'the relay did not answer' })
    }, CONNECT_TIMEOUT_MS)
    this.disposers.push(() => clearTimeout(timeout))

    this.disposers.push(
      connection.status.watch(status => {
        if (status === 'connected') this.set({ status: 'connected', error: undefined })
        else if (status === 'disconnected' && this.state.status === 'connected') this.set({ status: 'disconnected' })
      }),
    )
    // Announcements are the roster: one broadcast per speaker, named by pubkey. Subscribed, and
    // also polled every few seconds as the reference client does: a change can arrive without
    // the signal firing.
    this.disposers.push(connection.announced.subscribe(announced => this.reconcile(announced)))
    const poll = setInterval(() => this.reconcile(connection.announced.peek()), 3_000)
    this.disposers.push(() => clearInterval(poll))
    this.reconcile(connection.announced.peek())
  }

  /** The live connection, for a speaker to publish on. Undefined until `start` has connected. */
  get established(): Moq.Signals.Signal<Moq.Connection.Established | undefined> | undefined {
    return this.connection?.established
  }

  /** `Path.from`, for a speaker naming its broadcast; the library is loaded by `start`. */
  get lite(): typeof Moq | undefined {
    return this.moq
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    for (const pipeline of this.speakers.values()) pipeline.emitter.volume.set(this.volume)
  }

  /** Browsers start audio suspended until a gesture; the Listen tap is one, so resume on it. */
  async resume(): Promise<void> {
    for (const pipeline of this.speakers.values()) {
      const context = pipeline.decoder.context.peek()
      if (context !== undefined && context.state !== 'running') await context.resume().catch(() => undefined)
    }
  }

  stop(): void {
    this.stopped = true
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const pubkey of [...this.speakers.keys()]) this.drop(pubkey)
    try {
      this.connection?.close()
    } catch {
      this.connection?.enabled.set(false)
    }
    this.connection = undefined
    this.set({ status: 'idle', speakers: [], bytes: 0, bytesBy: new Map() })
  }

  private reconcile(announced: Set<Moq.Path.Valid>): void {
    const seen = new Set<Hex>()
    for (const path of announced) {
      const pubkey = String(path).toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pubkey)) continue
      seen.add(pubkey as Hex)
      if (!this.speakers.has(pubkey as Hex)) this.follow(pubkey as Hex)
    }
    for (const pubkey of [...this.speakers.keys()]) {
      if (!seen.has(pubkey)) this.drop(pubkey)
    }
    this.set({ speakers: [...this.speakers.keys()] })
  }

  private follow(pubkey: Hex): void {
    const connection = this.connection
    const moq = this.moq
    const watch = this.watch
    if (connection === undefined || moq === undefined || watch === undefined) return
    const broadcast = new watch.Broadcast({
      connection: connection.established,
      enabled: true,
      name: moq.Path.from(pubkey),
      reload: true,
    })
    const sync = new watch.Sync({ jitter: LATENCY_MS as Moq.Time.Milli })
    const source = new watch.Audio.Source(sync, { broadcast })
    const decoder = new watch.Audio.Decoder(source, { enabled: true })
    const emitter = new watch.Audio.Emitter(decoder, { volume: this.volume, muted: false })
    const stopStats = decoder.stats.subscribe(stats => {
      this.bytes.set(pubkey, stats?.bytesReceived ?? 0)
      let total = 0
      for (const count of this.bytes.values()) total += count
      this.set({ bytes: total, bytesBy: new Map(this.bytes) })
    })
    this.speakers.set(pubkey, { broadcast, sync, source, decoder, emitter, stopStats })
  }

  private drop(pubkey: Hex): void {
    const pipeline = this.speakers.get(pubkey)
    if (pipeline === undefined) return
    pipeline.stopStats()
    pipeline.emitter.close()
    pipeline.decoder.close()
    pipeline.source.close()
    pipeline.sync.close()
    pipeline.broadcast.close()
    this.speakers.delete(pubkey)
    this.bytes.delete(pubkey)
  }

  private set(patch: Partial<ListenerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }
}

/**
 * SPEAKING IN A PROTOCOL ROOM — the publishing half, on the same library generation.
 *
 * EGG-03: a speaker publishes ONE broadcast named by their pubkey hex, one track `audio/data`
 * of Opus at 48 kHz mono, and (EGG-12) a sibling `catalog.json`. `@moq/publish` 0.2.3 does all
 * of that from a microphone track — the reference web client is built on it, and another client's
 * speaker was written to match its framing — with WebCodecs where the browser has an Opus
 * encoder and a WASM one where it does not (Safari before 26).
 *
 * Mute is "stop publishing" (EGG-03 §8): the encoder is disabled, no frames go out, no silence
 * is faked. Listeners without the audio plane read the `muted` flag off presence instead.
 *
 * The connection is the listener's: a speaker also listens, and one session with a token that
 * carries `put` does both. A listener promoted mid-room reconnects with such a token first.
 */
export type SpeakerStatus = 'idle' | 'asking' | 'live' | 'muted' | 'denied' | 'failed'

export interface SpeakerState {
  status: SpeakerStatus
  error: string | undefined
}

export class RoomSpeaker {
  private broadcast: Publish.Broadcast | undefined
  private track: MediaStreamTrack | undefined
  private readonly listeners = new Set<(state: SpeakerState) => void>()
  private state: SpeakerState = { status: 'idle', error: undefined }

  get current(): SpeakerState {
    return this.state
  }

  onChange(listener: (state: SpeakerState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Ask for the microphone and start broadcasting on the listener's connection as `pubkey`. */
  async start(listener: RoomListener, pubkey: Hex): Promise<void> {
    const established = listener.established
    const moq = listener.lite
    if (established === undefined || moq === undefined) {
      this.set({ status: 'failed', error: 'not connected to the room' })
      return
    }
    this.set({ status: 'asking' })
    let track: MediaStreamTrack
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const first = stream.getAudioTracks()[0]
      if (first === undefined) throw new Error('no microphone track')
      track = first
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      this.set({
        status: name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed',
        error: err instanceof Error ? err.message : 'could not open the microphone',
      })
      return
    }
    if (this.state.status !== 'asking') {
      track.stop()
      return
    }
    try {
      const publish = await import('@moq/publish')
      this.track = track
      this.broadcast = new publish.Broadcast({
        connection: established,
        enabled: true,
        name: moq.Path.from(pubkey),
        audio: { source: track as Publish.Audio.Source, enabled: true },
      })
      this.set({ status: 'live', error: undefined })
    } catch (err) {
      track.stop()
      this.set({ status: 'failed', error: err instanceof Error ? err.message : 'could not start broadcasting' })
    }
  }

  /** Mute stops the frames; nothing else changes — the broadcast stays announced. */
  setMuted(muted: boolean): void {
    if (this.broadcast === undefined) return
    this.broadcast.audio.enabled.set(!muted)
    if (this.track !== undefined) this.track.enabled = !muted
    if (this.state.status === 'live' || this.state.status === 'muted') this.set({ status: muted ? 'muted' : 'live' })
  }

  stop(): void {
    try {
      this.broadcast?.close()
    } catch {
      // Closing an already-closed broadcast is not an error anybody can act on.
    }
    this.broadcast = undefined
    this.track?.stop()
    this.track = undefined
    this.set({ status: 'idle', error: undefined })
  }

  private set(patch: Partial<SpeakerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }
}
