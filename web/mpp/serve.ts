// The fuel pump (pump.ts) under Node instead of workerd, for a local game server or a test: node serve.ts [port]
import { createServer } from 'node:http'
import { pump } from './pump.ts'

const handle = pump()
const port = Number(process.argv[2] ?? 8787)
createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined
  const out = await handle(new Request('http://localhost:' + port + req.url, { method: req.method, headers, body })).catch((e) => { console.error(e); return new Response('pump failed', { status: 500 }) })
  res.writeHead(out.status, Object.fromEntries(out.headers))
  res.end(Buffer.from(await out.arrayBuffer()))
}).listen(port, () => console.log('[mpp] fuel pump on http://localhost:' + port + '/mpp/'))
