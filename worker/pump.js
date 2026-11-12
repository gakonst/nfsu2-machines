// Tempo fuel's pump: an MPP session server on Tempo testnet. Each 50 m can of fuel is one voucher of $0.001
// (pathUSD), the pump pays the gas (feePayer), and the client's channel settles when it closes at the race's end.
import { DurableObject } from 'cloudflare:workers';
import { Mppx, tempo } from 'mppx/server';
import { createClient, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Actions, Chain } from 'viem/tempo';

const PRICE = '0.001';
const METRES = 50;
const CURRENCY = '0x20c0000000000000000000006a37da5c996874be';

/** A request handler for /mpp/health and /mpp/fuel with a fresh, faucet-funded testnet wallet. */
export function pump() {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = createClient({ account, chain: Chain.testnet, pollingInterval: 100, transport: http() });
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const mppx = Mppx.create({
    secretKey: btoa(String.fromCharCode(...bytes)),
    realm: 'midnight-machines-fuel',
    methods: [tempo.session({ account, currency: CURRENCY, feePayer: true, chainId: Chain.testnet.id, getClient: () => client, voucherStateMaxAge: 60_000 })],
  });
  let ready = false;
  let funding;
  const fund = () => (funding ??= Actions.faucet.fundSync(client, { account, timeout: 60_000 }).then(
    () => { ready = true; },
    (e) => { console.error('pump faucet', e); funding = undefined; },
  ));
  fund();
  return async (request) => {
    const route = new URL(request.url).pathname.replace(/^\/mpp\//, '');
    if (route === 'health') return Response.json({ ready, pump: account.address, price: PRICE, metres: METRES, chainId: Chain.testnet.id });
    if (route === 'fuel') {
      await fund();
      const result = await mppx.session({ amount: PRICE, unitType: 'can', suggestedDeposit: '1' })(request);
      if (result.status === 402) return result.challenge;
      return result.withReceipt(Response.json({ ok: true, metres: METRES }));
    }
    return new Response('Not found', { status: 404 });
  };
}

/** One pump for the whole Worker (idFromName('pump')); the wallet and MPP server are made on first use. */
export class Pump extends DurableObject {
  async fetch(request) {
    try {
      return await (this.handle ??= pump())(request);
    } catch (e) {
      console.error('pump', e);
      return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
    }
  }
}
