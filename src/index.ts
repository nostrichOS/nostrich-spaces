// The events: what a room, a meeting, a heartbeat and a chat line look like on the wire.
export * from './events/room-event'
export * from './events/meeting-event'
export * from './events/presence-event'
export * from './events/live-event'
export * from './events/live-chat'
export * from './events/room-builders'
export * from './events/space'

// The audio: joining a room's relay as a listener, and speaking into it.
export * from './audio/room-wire'
export * from './audio/wire'

// The token service a host runs beside its relay.
export * from './auth/token-service'
export * from './auth/handler'
export { verifyNip98, nip98InputFromRequest, type Nip98Result, type Nip98Input, type Nip98Options } from './auth/nip98'

// The little core everything above stands on.
export * from './core/types'
export { getTags, getTagValues, nowSeconds, parseAddress, type BuildOptions, type ParsedAddress } from './core/events'
export { encodeNaddr, decodePointer, decodeNpub, type AddressPointer, type Nip19Pointer } from './core/keys'
export { normalizeRelayUrl, tryNormalizeRelayUrl } from './core/relays'
export { createHttpAuth, httpAuthHeader, type HttpAuthParams } from './core/http-auth'
export { PrivateKeySigner } from './core/private-key-signer'
