import type { RelayUrl } from './types'

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/**
 * Canonical form of a relay URL. `wss://Relay.Example.org/` and `relay.example.org` are the
 * same relay, and without one spelling a pool opens a socket per variant.
 *
 * @throws TypeError when the input cannot be a relay URL at all.
 */
export function normalizeRelayUrl(input: string): RelayUrl {
  const raw = input.trim()
  if (raw === '') throw new TypeError('relay url is empty')
  const hadScheme = SCHEME_RE.test(raw)
  const withScheme = hadScheme ? raw : `wss://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new TypeError(`invalid relay url: ${input}`)
  }
  if (url.hostname === '') throw new TypeError(`relay url has no host: ${input}`)
  // A public relay has a dot in its name; `https:/typo.example` parses to the host "https".
  if (!url.hostname.includes('.') && !isLocalHost(url.hostname)) throw new TypeError(`relay url has no domain: ${input}`)
  let protocol: 'ws:' | 'wss:'
  switch (url.protocol.toLowerCase()) {
    case 'ws:':
    case 'http:':
      protocol = 'ws:'
      break
    case 'wss:':
    case 'https:':
      protocol = 'wss:'
      break
    default:
      throw new TypeError(`unsupported relay scheme: ${url.protocol}`)
  }
  if (isLocalHost(url.hostname)) {
    if (!hadScheme) protocol = 'ws:'
  } else {
    protocol = 'wss:'
  }
  let port = url.port
  if ((protocol === 'wss:' && port === '443') || (protocol === 'ws:' && port === '80')) port = ''
  let path = url.pathname.replace(/\/{2,}/g, '/')
  while (path.endsWith('/')) path = path.slice(0, -1)
  url.searchParams.sort()
  const search = url.search === '?' ? '' : url.search
  const auth = url.username === '' ? '' : `${url.username}${url.password === '' ? '' : `:${url.password}`}@`
  const host = port === '' ? url.hostname : `${url.hostname}:${port}`
  return `${protocol}//${auth}${host}${path}${search}`
}

/** Non-throwing `normalizeRelayUrl`, for whatever strangers put in their tags. */
export function tryNormalizeRelayUrl(input: string): RelayUrl | undefined {
  try {
    return normalizeRelayUrl(input)
  } catch {
    return undefined
  }
}
