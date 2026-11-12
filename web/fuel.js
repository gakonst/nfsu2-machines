// Tempo fuel (only with ?tempo in the address; ?tempo=<url> for a pump elsewhere): a race's distance paid as it is driven, one MPP session per race on
// Tempo testnet against the Worker's /mpp/fuel. Each 50 m can is one $0.001 voucher; 200 m stay paid ahead of the car;
// the session closes and settles on chain at the race's end. mppx and viem load from esm.sh only here.

export const PRICE = 0.001;
export const METERS_PER_CAN = 50;
export const AHEAD_M = 200;
const EXPLORER = 'https://explore.testnet.tempo.xyz/tx/';
const KEY = 'mm.tempo.key';
const MPPX = 'https://esm.sh/mppx@0.16.0/client?deps=viem@2.57.12';
const VIEM = 'https://esm.sh/viem@2.57.12';

export const tempoWanted = () => new URLSearchParams(location.search).has('tempo');
/** ?tempo uses this origin's /mpp/; ?tempo=<url> a fuel pump elsewhere. */
export function tempoBase() {
  const v = new URLSearchParams(location.search).get('tempo');
  return v && /^https?:\/\//.test(v) ? v.replace(/\/?$/, '/') : location.origin + '/mpp/';
}

/** Cans to buy now, with driven and paid metres of this race. */
export function cansDue(driven, paid) {
  const left = paid - Math.max(0, driven);
  return left >= AHEAD_M ? 0 : Math.ceil((AHEAD_M - left) / METERS_PER_CAN);
}
export const spend = (cans) => Math.round(cans * PRICE * 1e6) / 1e6;

let libs = null;
function load() {
  return (libs ??= Promise.all([import(MPPX), import(VIEM), import(VIEM + '/accounts'), import(VIEM + '/tempo')]).then(
    ([mppx, viem, accounts, tempo]) => ({ tempo: mppx.tempo, viem, accounts, Actions: tempo.Actions, Chain: tempo.Chain }),
    (e) => { libs = null; throw e; },
  ));
}

export class TempoFuel {
  /** panel: the #fuel element; base: where /mpp/ lives (this origin by default). */
  constructor(panel, base = location.origin + '/mpp/') {
    this.panel = panel;
    this.base = base;
    this.race = 0;
    this.wallet = null;
    this.funded = null;
    this.status = 'loading wallet\u2026';
    this.link = '';
    this.reset();
  }

  reset() { this.paid = 0; this.cans = 0; this.busy = false; this.channel = null; this.driven = 0; }

  async wallet_() {
    const { viem, accounts, Chain, Actions } = await load();
    let key = localStorage.getItem(KEY);
    if (!key || !/^0x[0-9a-f]{64}$/.test(key)) { key = accounts.generatePrivateKey(); localStorage.setItem(KEY, key); }
    const account = accounts.privateKeyToAccount(key);
    const client = viem.createClient({ account, chain: Chain.testnet, pollingInterval: 250, transport: viem.http() });
    this.wallet = { account, client };
    this.funded ??= Actions.faucet.fundSync(client, { account, timeout: 60_000 }).then(
      () => { this.status = 'wallet ' + account.address.slice(0, 8) + '\u2026 funded'; },
      (e) => { this.funded = null; this.status = 'faucet: ' + (e?.shortMessage ?? e); },
    );
    return this.wallet;
  }

  /** A race starts: pay(paid_m) tells the game (mm_fuel locally, or the room in multiplayer). */
  begin(pay) {
    this.race++;
    this.reset();
    this.pay = pay;
    this.link = '';
    this.panel.hidden = false;
    this.wallet_().catch((e) => { this.status = 'could not load mppx: ' + e; });
    this.show();
  }

  /** Every frame with the local car's distance_m. */
  update(driven) {
    this.driven = driven;
    if (this.pay && !this.busy && this.wallet && cansDue(driven, this.paid) > 0) this.buy(this.race);
    this.show();
  }

  async buy(race) {
    this.busy = true;
    try {
      await this.funded;
      const { tempo } = await load();
      this.channel ??= tempo.session.manager({ client: this.wallet.client, maxDeposit: '1' });
      const res = await this.channel.fetch(this.base + 'fuel');
      if (!res.ok) throw new Error('fuel ' + res.status);
      if (race !== this.race) return;
      this.cans++;
      this.paid += METERS_PER_CAN;
      this.status = 'channel open';
      this.pay?.(this.paid);
    } catch (e) {
      this.status = 'not paid: ' + (e?.shortMessage ?? e?.message ?? e);
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      this.busy = false;
    }
  }

  /** The race ended: close the channel; the settle transaction returns the unspent deposit. */
  async end() {
    const ch = this.channel, cans = this.cans;
    this.pay = null;
    this.channel = null;
    this.race++;
    if (!ch) { this.show(); return; }
    this.status = 'settling\u2026';
    this.show();
    try {
      const r = await ch.close();
      this.status = 'settled ' + cans + ' cans';
      if (r?.txHash) this.link = EXPLORER + r.txHash;
    } catch (e) {
      this.status = 'close failed: ' + (e?.shortMessage ?? e?.message ?? e);
    }
    this.show();
  }

  hide() { this.panel.hidden = true; }

  show() {
    const ahead = Math.max(0, this.paid - this.driven);
    this.panel.classList.toggle('empty', this.pay && ahead <= 0 && this.cans > 0);
    this.panel.replaceChildren();
    const b = document.createElement('b');
    b.textContent = 'Tempo fuel';
    const line = document.createElement('div');
    line.textContent = (ahead / 1000).toFixed(2) + ' km ahead \u00b7 ' + this.cans + ' cans \u00b7 $' + spend(this.cans).toFixed(3);
    const st = document.createElement('div');
    st.textContent = this.status;
    this.panel.append(b, line, st);
    if (this.link) {
      const a = document.createElement('a');
      a.href = this.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'settle tx \u2197';
      this.panel.append(a);
    }
  }
}
