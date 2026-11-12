import { Mppx, tempo } from 'mppx/server'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const PRICE = '0.001'
const METRES = 50
const currency = '0x20c0000000000000000000006a37da5c996874be'

export function pump() {
  const account = privateKeyToAccount(generatePrivateKey())
  const client = createClient({ account, chain: Chain.testnet, pollingInterval: 100, transport: http() })
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const mppx = Mppx.create({
    secretKey: btoa(String.fromCharCode(...bytes)),
    realm: 'nfsu2-tempo-fuel',
    methods: [tempo.session({ account, currency, feePayer: true, chainId: Chain.testnet.id, getClient: () => client, voucherStateMaxAge: 60_000 })],
  })
  let ready = false
  let funding: Promise<void> | undefined
  const fund = () => (funding ??= Actions.faucet.fundSync(client, { account, timeout: 60_000 }).then(() => { ready = true }, (e) => { console.error(e); funding = undefined }))
  fund()
  return async (request: Request) => {
    const route = new URL(request.url).pathname.replace(/^\/mpp\//, '')
    if (route === 'health') return Response.json({ ready, pump: account.address, price: PRICE, metres: METRES, chainId: Chain.testnet.id })
    if (route === 'fuel') {
      await fund()
      const result = await mppx.session({ amount: PRICE, unitType: 'can', suggestedDeposit: '1' })(request)
      if (result.status === 402) return result.challenge
      return result.withReceipt(Response.json({ ok: true }))
    }
    return new Response('Not found', { status: 404 })
  }
}
