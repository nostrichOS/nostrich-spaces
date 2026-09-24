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
 *     Watch.Broadcast → Sync → Audio.Source → Decoder → Emitter, which is the speaker — every
 *     one of them but the reader's OWN, which is their own microphone coming back (EGG-03 §6).
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
  /**
   * Pubkeys currently broadcasting audio, in the order they were heard — INCLUDING the reader's
   * own while they hold the microphone. It is the room's roster and not the list of pipelines:
   * the reader's broadcast is heard about and deliberately never subscribed (`reconcile`), and a
   * host talking alone must not read "Waiting for the host to speak" on their own screen.
   */
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
  /** Every pubkey heard broadcasting, in arrival order: the roster, the reader included. */
  private heard: Hex[] = []
  /** The pubkey this session may publish under — the one broadcast it must not subscribe to. */
  private mine: Hex | undefined
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
   * broadcast is named by that same pubkey (EGG-03). `self` is that pubkey, and it names the one
   * broadcast this session will not listen to.
   */
  async start(signer: Signer = PrivateKeySigner.generate(), options: { publish?: boolean; self?: Hex } = {}): Promise<void> {
    // Only a session that may publish can own a broadcast in this room, so only that session
    // skips it: the same key signed in on a second device is another microphone and is heard.
    this.mine = options.publish === true ? options.self : undefined
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

  /**
   * Browsers start audio suspended until a gesture; the Listen tap is one, so resume on it.
   * Every context is asked in the same turn, not one per `await`: Safari honours a resume only
   * while the tap is still being handled, so the second speaker of a sequential loop stayed silent.
   */
  async resume(): Promise<void> {
    const waiting: Promise<void>[] = []
    for (const pipeline of this.speakers.values()) {
      const context = pipeline.decoder.context.peek()
      if (context !== undefined && context.state !== 'running') waiting.push(context.resume().catch(() => undefined))
    }
    await Promise.all(waiting)
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
    this.heard = []
    this.set({ status: 'idle', speakers: [], bytes: 0, bytesBy: new Map() })
  }

  private reconcile(announced: Set<Moq.Path.Valid>): void {
    const seen = new Set<Hex>()
    for (const path of announced) {
      const pubkey = String(path).toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pubkey)) continue
      seen.add(pubkey as Hex)
      /*
       * A SPEAKER NEVER SUBSCRIBES TO THEIR OWN BROADCAST — EGG-03 §6, in those words, "would
       * create an audio loopback through the relay". The relay announces a broadcast back to
       * the session that published it, and this loop followed every announced pubkey, so from
       * the moment a host unmuted they heard their own voice a jitter buffer (150 ms) plus an
       * encode and a decode late. `echoCancellation` cannot touch it — AEC removes
       * what a loudspeaker leaks into the microphone, and this arrives as somebody's audio and
       * is played on purpose, so it echoes in headphones too.
       */
      if (pubkey === this.mine) continue
      if (!this.speakers.has(pubkey as Hex)) this.follow(pubkey as Hex)
    }
    for (const pubkey of [...this.speakers.keys()]) {
      if (!seen.has(pubkey)) this.drop(pubkey)
    }
    // The roster keeps its arrival order, gains whoever is new and loses whoever stopped.
    this.heard = [...this.heard, ...[...seen].filter(pubkey => !this.heard.includes(pubkey))].filter(pubkey => seen.has(pubkey))
    this.set({ speakers: this.heard })
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
 *
 * ── The ring over the reader's own face ──────────────────────────────────────────────
 *
 * Everybody else's talking ring is drawn from the relay's byte count, and the reader's cannot be:
 * their own broadcast is never subscribed (EGG-03 §6, `reconcile` above). So it is measured where
 * the sound actually is — an AnalyserNode on the published track, wired to NOTHING else, so the
 * microphone is read and never played. It is the better signal besides: no round trip, so the ring
 * moves with the voice instead of a jitter buffer behind it.
 */
export type SpeakerStatus = 'idle' | 'asking' | 'live' | 'muted' | 'denied' | 'failed'

export interface SpeakerState {
  status: SpeakerStatus
  error: string | undefined
}

/**
 * Peak amplitude, of a full-scale 1, that is a voice rather than a room. Automatic gain control is
 * on, which puts speech peaks well above 0.1, and noise suppression puts a quiet room near zero.
 */
const TALKING_PEAK = 0.05

/** How long one loud sample keeps the ring lit, so the gaps between syllables do not blink it. */
const TALKING_HOLD_MS = 700

/** The meter's own clock, faster than the view samples so a short word is not stepped over. */
const METER_MS = 100

/** How every microphone is opened, the first and any switched to: one voice, cleaned up. */
const MIC_CONSTRAINTS = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const

/**
 * WHAT THE ENCODER IS TOLD ABOUT THE MICROPHONE: one channel, 48 kHz. `@moq/publish` reads both
 * off `getSettings()` and trusts them, and each, left to the browser, makes a silent room.
 *
 * ONE CHANNEL. The encoder is built for `channelCount ?? 2` and fed the microphone's channels sliced
 * DOWN to that count, never up. WebKit (Safari, every iPhone) reports no `channelCount`, so the
 * encoder is stereo, the microphone mono, and the first frame fails "Input audio buffer is
 * incompatible with codec parameters"; the library answers by resetting the track. The speaker sees
 * a working mic; every listener's `audio/data` subscription is cancelled from the speaker's side a
 * fraction of a second after it starts, before a single frame.
 *
 * 48 kHz. The library runs its capture at the microphone's own rate and encodes Opus at it. Chrome
 * and WebKit both ENCODE Opus at 44.1 kHz without complaint and neither can DECODE it (Chrome refuses
 * the decoder, "Unsupported configuration"; WebKit fails every packet), while
 * `AudioDecoder.isConfigSupported` says yes to it all the same. So a speaker whose microphone runs at
 * 44.1 kHz (common on Windows and on USB microphones) puts a full stream on the relay that no
 * listener can play. Opus is a 48 kHz codec and EGG-03 says so: the capture context runs at 48 kHz
 * and the browser resamples the microphone into it (checked in Chrome and WebKit; Firefox not
 * measured).
 *
 * The track itself is untouched: only the settings the library reads say so.
 * `wire-speaker.test.ts` holds both.
 */
export function opusSource(track: MediaStreamTrack): MediaStreamTrack {
  const settings = track.getSettings.bind(track)
  track.getSettings = () => ({ ...settings(), channelCount: 1, sampleRate: OPUS_SAMPLE_RATE })
  return track
}

/** Opus's own rate, the one every decoder accepts (EGG-03). */
export const OPUS_SAMPLE_RATE = 48_000

export class RoomSpeaker {
  private broadcast: Publish.Broadcast | undefined
  private track: MediaStreamTrack | undefined
  private meter: { context: AudioContext; timer: ReturnType<typeof setInterval> } | undefined
  private loudAt = 0
  private readonly listeners = new Set<(state: SpeakerState) => void>()
  private state: SpeakerState = { status: 'idle', error: undefined }

  /**
   * Whether the microphone has heard the reader in the last moment. False while muted, because
   * mute is "stop publishing" and a muted mic is not a voice anybody hears.
   */
  get talking(): boolean {
    return this.state.status === 'live' && Date.now() - this.loudAt < TALKING_HOLD_MS
  }

  get current(): SpeakerState {
    return this.state
  }

  onChange(listener: (state: SpeakerState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The input this broadcast is reading, as the browser names it; undefined before `start`. */
  get device(): string | undefined {
    return this.track?.getSettings().deviceId
  }

  /**
   * Ask for the microphone and start broadcasting on the listener's connection as `pubkey`.
   * `device` is an input the caller remembered, asked for as a preference:
   * gone, and the browser's default opens instead.
   */
  async start(listener: RoomListener, pubkey: Hex, device?: string): Promise<void> {
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
        audio: { ...MIC_CONSTRAINTS, ...(device === undefined ? {} : { deviceId: { ideal: device } }) },
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
        audio: { source: opusSource(track) as Publish.Audio.Source, enabled: true },
      })
      this.listen(track)
      this.set({ status: 'live', error: undefined })
    } catch (err) {
      track.stop()
      this.set({ status: 'failed', error: err instanceof Error ? err.message : 'could not start broadcasting' })
    }
  }

  /**
   * ANOTHER MICROPHONE, MID-BROADCAST (2026-09-24). The library's audio source is a signal, and
   * setting it rebuilds the capture the same way mute and unmute already do, so a listener sees
   * the audio rendition go and come back and re-subscribes, as it does for every unmute. The
   * broadcast, its name and the connection stay.
   *
   * The new input is opened BEFORE the old one is let go, and `exact`, because the reader chose
   * it: a device that refuses (unplugged, held by another app) leaves the current microphone
   * broadcasting and answers false, never silence. Muted stays muted.
   */
  async switchTo(device: string): Promise<boolean> {
    const broadcast = this.broadcast
    const previous = this.track
    if (broadcast === undefined || previous === undefined) return false
    if (previous.getSettings().deviceId === device) return true
    let next: MediaStreamTrack
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS, deviceId: { exact: device } } })
      const first = stream.getAudioTracks()[0]
      if (first === undefined) throw new Error('no microphone track')
      next = first
    } catch {
      return false
    }
    // Stopped, or switched again, while the browser was asking.
    if (this.broadcast !== broadcast || this.track !== previous) {
      next.stop()
      return false
    }
    next.enabled = previous.enabled
    this.track = next
    broadcast.audio.source.set(opusSource(next) as Publish.Audio.Source)
    previous.stop()
    this.quiet()
    this.listen(next)
    return true
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
    this.quiet()
    this.loudAt = 0
    this.track?.stop()
    this.track = undefined
    this.set({ status: 'idle', error: undefined })
  }

  private quiet(): void {
    if (this.meter === undefined) return
    clearInterval(this.meter.timer)
    void this.meter.context.close().catch(() => undefined)
    this.meter = undefined
  }

  /**
   * The meter. `source.connect(analyser)` and nothing further: an AnalyserNode is a tap, and a
   * node wired on to `destination` would be the loopback this file exists to avoid, with not even
   * a relay in the way. Failure is a ring that never lights, never a microphone that does not work.
   */
  private listen(track: MediaStreamTrack): void {
    try {
      const Context = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Context === undefined) return
      const context = new Context()
      void context.resume().catch(() => undefined)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      context.createMediaStreamSource(new MediaStream([track])).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(samples)
        let peak = 0
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128) / 128)
        if (peak >= TALKING_PEAK) this.loudAt = Date.now()
      }, METER_MS)
      this.meter = { context, timer }
    } catch {
      // No meter is a ring that never lights; the room and the microphone are untouched.
    }
  }

  private set(patch: Partial<SpeakerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }
}
