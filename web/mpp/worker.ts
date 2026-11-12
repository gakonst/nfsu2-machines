import { DurableObject } from 'cloudflare:workers'
import { pump } from './pump'

type Env = { PUMP: DurableObjectNamespace<Pump>; ORIGINS?: string }

function cors(request: Request, env: Env, response: Response) {
  const origin = request.headers.get('origin')
  const allowed = (env.ORIGINS ?? '*').split(',').map((s) => s.trim())
  if (!origin || !(allowed.includes('*') || allowed.includes(origin))) return response
  const out = new Response(response.body, response)
  out.headers.set('access-control-allow-origin', origin)
  out.headers.set('access-control-allow-headers', 'authorization, content-type')
  out.headers.set('access-control-allow-methods', 'GET, POST, HEAD, OPTIONS')
  out.headers.set('access-control-expose-headers', 'www-authenticate, payment-receipt')
  out.headers.set('vary', 'origin')
  return out
}

export class Pump extends DurableObject<Env> {
  private handle: ReturnType<typeof pump> | undefined
  async fetch(request: Request) {
    return (this.handle ??= pump())(request)
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (!new URL(request.url).pathname.startsWith('/mpp/')) return new Response('Not found', { status: 404 })
    if (request.method === 'OPTIONS') return cors(request, env, new Response(null, { status: 204 }))
    return cors(request, env, await env.PUMP.get(env.PUMP.idFromName('pump')).fetch(request))
  },
} satisfies ExportedHandler<Env>
