#!/usr/bin/env node
/**
 * The relay token key pair, once.
 *
 *   node scripts/keygen.mjs infra/public.jwk ./private.jwk
 *
 * Writes the PUBLIC half where the relay reads it (mount it as /etc/moq/public.jwk) and the
 * PRIVATE half to the second path, mode 600, to be placed in the token service's environment
 * as `MOQ_AUTH_PRIVATE_JWK` and then deleted from disk. Refuses to overwrite an existing public
 * key: rotating invalidates every live token, so it is a deliberate act, not a re-run.
 */
import { generateKeyPair, exportJWK } from 'jose'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

const [publicPath, privatePath] = process.argv.slice(2)
if (publicPath === undefined || privatePath === undefined) {
  console.error('usage: node scripts/keygen.mjs <public.jwk to write> <private.jwk to write>')
  process.exit(1)
}
if (existsSync(publicPath)) {
  console.error(`refusing to overwrite ${publicPath}; delete it first if you really mean to rotate`)
  process.exit(1)
}
const kid = `moq-auth-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`
const pair = await generateKeyPair('ES256', { extractable: true })
const priv = { ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256', use: 'sig' }
// `key_ops` is what moq-relay 0.10.x insists on; `use` is what RFC 7517 readers expect.
const pub = { ...(await exportJWK(pair.publicKey)), kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] }
mkdirSync(dirname(publicPath), { recursive: true })
writeFileSync(publicPath, JSON.stringify(pub, null, 2) + '\n')
writeFileSync(privatePath, JSON.stringify(priv), { mode: 0o600 })
console.log(`public key  -> ${publicPath} (kid ${kid})`)
console.log(`private key -> ${privatePath} (mode 600). Put its contents in MOQ_AUTH_PRIVATE_JWK, then delete the file.`)
