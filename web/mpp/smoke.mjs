// Pays for a race's fuel the way web/src/app/mppfuel.ts does, against a fuel server (default: wrangler dev):
//   node smoke.mjs [url] [cans]
import { tempo } from 'mppx/client'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const url = (process.argv[2] ?? 'http://localhost:8787/mpp/').replace(/\/?$/, '/')
const cans = Number(process.argv[3] ?? 20)
const account = privateKeyToAccount(generatePrivateKey())
const client = createClient({ account, chain: Chain.testnet, pollingInterval: 250, transport: http() })
console.log('health', await fetch(url + 'health').then((r) => r.json()))
let t = performance.now()
await Actions.faucet.fundSync(client, { account, timeout: 60_000 })
console.log('wallet', account.address, 'funded in', (performance.now() - t).toFixed(0), 'ms')
const session = tempo.session.manager({ client, maxDeposit: '1' })
const ms = []
for (let i = 0; i < cans; i++) {
  t = performance.now()
  const res = await session.fetch(url + 'fuel')
  if (!res.ok) throw new Error('fuel ' + res.status + ' ' + (await res.text()))
  ms.push(performance.now() - t)
}
console.log('channel', session.channelId, 'cumulative', session.cumulative, 'open', ms[0].toFixed(0), 'ms; vouchers p50', ms.slice(1).sort((a, b) => a - b)[Math.floor((ms.length - 1) / 2)]?.toFixed(0), 'ms')
t = performance.now()
const closed = await session.close()
console.log('closed in', (performance.now() - t).toFixed(0), 'ms', closed?.txHash ? Chain.testnet.blockExplorers.default.url + '/tx/' + closed.txHash : JSON.stringify(closed))
