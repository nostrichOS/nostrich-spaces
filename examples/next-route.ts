/**
 * THE TOKEN SERVICE IN NEXT.JS (App Router) — one file at `app/api/moq/auth/route.ts` and one
 * at `app/api/moq/.well-known/jwks.json/route.ts` (call `handleJwks` there). The room events
 * you publish then carry `["auth", "https://your.host/api/moq"]`.
 */
import { createTokenService } from '../src/index'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const service = createTokenService({
  privateJwk: process.env['MOQ_AUTH_PRIVATE_JWK'],
  origin: process.env['PUBLIC_ORIGIN'] ?? 'https://your.host',
  relays: ['wss://relay-1.example.com', 'wss://relay-2.example.com', 'wss://relay-3.example.com'],
})

export function OPTIONS(): Response {
  return service.handleOptions()
}

export async function POST(request: Request): Promise<Response> {
  return service.handleAuth(request)
}

// In the jwks.json route:
// export async function GET(): Promise<Response> { return service.handleJwks() }
