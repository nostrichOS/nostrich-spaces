import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Hex } from '../core/types'

/**
 * WHAT A SPEAKER HANDS THE ENCODER. `@moq/publish` builds its Opus encoder from the source track's
 * `getSettings()`: channels from `channelCount ?? 2`, rate from `sampleRate`. Left to the browser,
 * WebKit (which reports no `channelCount`) gets a stereo encoder for a mono microphone and fails the
 * first frame, and a 44.1 kHz microphone gets a stream that no decoder will play. So what is asserted
 * here is the track the library is HANDED: one channel at 48 kHz, on the first microphone and on
 * every one switched to mid-broadcast, which must never leave the room silent.
 *
 * These tests replace the browser and the library, so they hold the contract, not the sound. Before
 * shipping a change to the speaker, listen to it: a real speaker in Chrome and in WebKit, a real
 * listener that DECODES (a byte counter passes both failures above, because the stream is on the wire
 * and simply cannot be played).
 */

const library = vi.hoisted(() => ({ sources: [] as MediaStreamTrack[] }))

vi.mock('@moq/publish', () => ({
  Broadcast: class {
    audio = {
      enabled: { set: () => undefined },
      source: { set: (track: MediaStreamTrack) => library.sources.push(track) },
    }
    constructor(props: { audio: { source: MediaStreamTrack } }) {
      library.sources.push(props.audio.source)
    }
    close() {}
  },
}))

import { OPUS_SAMPLE_RATE, RoomSpeaker, opusSource, type RoomListener } from './wire'

interface FakeTrack {
  enabled: boolean
  stopped: boolean
  getSettings: () => MediaTrackSettings
  stop: () => void
}

const asked: MediaTrackConstraints[] = []
const opened: FakeTrack[] = []
let refuse = new Set<string>()

/** A microphone the way WebKit describes one: no channel count, and here a 44.1 kHz rate. */
function microphone(deviceId: string): FakeTrack {
  const made: FakeTrack = {
    enabled: true,
    stopped: false,
    getSettings: () => ({ deviceId, sampleRate: 44100 }),
    stop: () => {
      made.stopped = true
    },
  }
  opened.push(made)
  return made
}

beforeEach(() => {
  asked.length = 0
  opened.length = 0
  library.sources.length = 0
  refuse = new Set()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async ({ audio }: { audio: MediaTrackConstraints }) => {
        asked.push(audio)
        const wanted = audio.deviceId as { ideal?: string; exact?: string } | undefined
        const device = wanted?.exact ?? wanted?.ideal ?? 'default'
        if (refuse.has(device)) throw Object.assign(new Error('busy'), { name: 'NotReadableError' })
        const track = microphone(device)
        return { getAudioTracks: () => [track] }
      },
    },
  })
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices')
})

const listener = { established: {}, lite: { Path: { from: (name: string) => name } } } as unknown as RoomListener
const PUBKEY = 'ab'.repeat(32) as Hex

describe('opusSource', () => {
  it('says one channel at 48 kHz whatever the browser reported, and keeps everything else', () => {
    expect(OPUS_SAMPLE_RATE).toBe(48000)
    const said = opusSource(microphone('usb') as unknown as MediaStreamTrack).getSettings()
    expect(said).toEqual({ deviceId: 'usb', sampleRate: 48000, channelCount: 1 })
  })
})

describe('RoomSpeaker', () => {
  it('hands the library one channel at 48 kHz, and asks for a remembered input only as a preference', async () => {
    const speaker = new RoomSpeaker()
    await speaker.start(listener, PUBKEY, 'usb')
    expect(asked[0]?.deviceId).toEqual({ ideal: 'usb' })
    expect(library.sources[0]?.getSettings()).toMatchObject({ channelCount: 1, sampleRate: 48000 })
    expect(speaker.device).toBe('usb')
    speaker.stop()
  })

  it('asks for no particular input when none was chosen', async () => {
    const speaker = new RoomSpeaker()
    await speaker.start(listener, PUBKEY)
    expect(asked[0]).not.toHaveProperty('deviceId')
    speaker.stop()
  })

  it('switches microphone mid-broadcast: the new one opened first, said mono at 48 kHz, the old one let go after', async () => {
    const speaker = new RoomSpeaker()
    await speaker.start(listener, PUBKEY)
    expect(await speaker.switchTo('usb')).toBe(true)
    expect(asked[1]?.deviceId).toEqual({ exact: 'usb' })
    expect(library.sources[1]?.getSettings()).toMatchObject({ deviceId: 'usb', channelCount: 1, sampleRate: 48000 })
    expect(opened[0]?.stopped).toBe(true)
    speaker.stop()
  })

  it('keeps the current microphone broadcasting when the chosen one refuses', async () => {
    const speaker = new RoomSpeaker()
    await speaker.start(listener, PUBKEY)
    refuse = new Set(['held-elsewhere'])
    expect(await speaker.switchTo('held-elsewhere')).toBe(false)
    expect(library.sources).toHaveLength(1)
    expect(opened[0]?.stopped).toBe(false)
    speaker.stop()
  })

  it('carries mute across a switch, and lets go of an input that arrives after the broadcast stopped', async () => {
    const speaker = new RoomSpeaker()
    await speaker.start(listener, PUBKEY)
    speaker.setMuted(true)
    await speaker.switchTo('usb')
    expect(opened[1]?.enabled).toBe(false)
    expect(speaker.current.status).toBe('muted')
    const late = speaker.switchTo('headset')
    speaker.stop()
    expect(await late).toBe(false)
    expect(opened[2]?.stopped).toBe(true)
  })
})
