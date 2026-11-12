// Tempo fuel: a race's distance paid as it is driven, over one MPP session per race on Tempo testnet, as Tempo
// Arcade's racer buys its fuel cans (tempoxyz/arcade src/payments.ts sessionDriver).  On only with ?tempo in the
// page's address (?tempo=<url> for a fuel server elsewhere; web/mpp/ is one).
// runtime/mppfuel.c publishes the race's number and distance ("mpp_race", "mpp_dist"); this pays a voucher per can
// ahead of the car and tells the game how far it may go (IEV_MPP MPP_PAID).  Past that the car crawls on its reserve.
// At the race's end the channel is closed and settled on chain, the unspent deposit back to the wallet.
import { tempo } from 'mppx/client';
import { createClient, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Actions, Chain } from 'viem/tempo';
import type { GameSession } from './game';
import { localStore, TEMPO_KEY } from './prefs';
import { cansDue, METERS_PER_CAN, spend } from './mppfuel-logic';
import { t } from './i18n';

export const MPP_ON = 1, MPP_OFF = 2, MPP_PAID = 3;
const EXPLORER = Chain.testnet.blockExplorers!.default.url;

function wallet() {
  let key = localStore.get(TEMPO_KEY) as `0x${string}` | null;
  if (!key || !/^0x[0-9a-f]{64}$/.test(key)) { key = generatePrivateKey(); localStore.set(TEMPO_KEY, key); }
  const account = privateKeyToAccount(key);
  return { account, client: createClient({ account, chain: Chain.testnet, pollingInterval: 250, transport: http() }) };
}

export class MppFuel {
  private root: HTMLElement;
  private line: HTMLElement;
  private session: GameSession | null = null;
  private timer = 0;
  private race = 0;
  private paid = 0;
  private cans = 0;
  private busy = false;
  private told = false;
  private channel: ReturnType<typeof tempo.session.manager> | null = null;
  private w: ReturnType<typeof wallet> | null = null;
  private funded: Promise<void> | null = null;

  constructor(stage: HTMLElement, private deps: { url: string; log(s: string): void }) {
    const p = this.root = document.createElement('div');
    p.className = 'mpp-fuel'; p.hidden = true; p.dataset.nfsu2Ui = '';
    p.innerHTML = '<b></b><span></span>';
    p.querySelector('b')!.textContent = t('Tempo fuel');
    this.line = p.querySelector('span')!;
    stage.append(p);
  }

  start(session: GameSession) {
    this.session = session;
    this.w = wallet();
    const { account, client } = this.w;
    this.deps.log('[mpp] Tempo fuel from ' + this.deps.url + ', paid by ' + account.address);
    this.funded = Actions.faucet.fundSync(client, { account, timeout: 60_000 }).then(() => {}, (e) => { this.funded = null; this.deps.log('[mpp] faucet: ' + e); });
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  stop() {
    clearInterval(this.timer);
    void this.settle();
    this.session?.input?.mpp?.(MPP_OFF, 0);
    this.session = null; this.told = false; this.race = 0; this.root.hidden = true;
  }

  private tick() {
    const s = this.session, st = s?.status?.read();
    if (!s?.input?.mpp || !st) return;
    if (!this.told) this.told = s.input.mpp(MPP_ON, 0);
    const race = st.get('mpp_race') ?? 0, dist = st.get('mpp_dist') ?? 0;
    if (race !== this.race) {
      if (this.race) void this.settle();
      this.race = race; this.paid = 0; this.cans = 0;
      this.root.hidden = !race;
    }
    if (!race) return;
    this.show(dist);
    if (!this.busy && cansDue(dist, this.paid) > 0) void this.buy(race);
  }

  private async buy(race: number) {
    this.busy = true;
    try {
      await this.funded;
      if (!this.channel) this.channel = tempo.session.manager({ client: this.w!.client as never, maxDeposit: '1' });
      const t0 = performance.now();
      const res = await this.channel.fetch(this.deps.url + 'fuel');
      if (!res.ok) throw new Error('fuel ' + res.status);
      if (race !== this.race) return;
      this.cans++; this.paid += METERS_PER_CAN;
      this.session?.input?.mpp?.(MPP_PAID, this.paid);
      if (this.cans === 1) this.deps.log('[mpp] race ' + race + ': channel ' + this.channel.channelId + ' open in ' + (performance.now() - t0).toFixed(0) + ' ms');
    } catch (e) {
      this.deps.log('[mpp] fuel not paid: ' + e);
      await new Promise(r => setTimeout(r, 1000));
    } finally { this.busy = false; }
  }

  private async settle() {
    const ch = this.channel;
    this.channel = null;
    if (!ch) return;
    try {
      const r = await ch.close() as { txHash?: string } | undefined;
      this.deps.log('[mpp] race settled: ' + this.cans + ' cans, $' + spend(this.cans) + (r?.txHash ? ', ' + EXPLORER + '/tx/' + r.txHash : ''));
    } catch (e) { this.deps.log('[mpp] close: ' + e); }
  }

  private show(dist: number) {
    const left = Math.max(0, this.paid - dist);
    this.line.textContent = (left / 1000).toFixed(2) + ' km · ' + this.cans + ' × $0.001 · $' + spend(this.cans).toFixed(3);
    this.root.classList.toggle('empty', left <= 0);
  }
}
