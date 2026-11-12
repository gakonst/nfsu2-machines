# Tempo fuel: a race paid over MPP

With `?tempo` in the page's address, a race of this game alone (not free roam, LAN or Online) runs on fuel paid
for as it is driven, over one MPP session per race on Tempo testnet, the way Tempo Arcade's racer buys fuel cans.

- `runtime/mppfuel.c` (a frame call, so no new lift) adds up the player's car's distance while the race runs and
  publishes it as the status counters `mpp_race` and `mpp_dist`. The page sends how far the car may go
  (`IEV_MPP`); past that the car's governor drops to 12 mph until the next voucher lands, and goes back at the race's end.
- `web/src/app/mppfuel.ts` opens a session (`tempo.session.manager`, $1 deposit) when the race loads, pays one
  $0.001 voucher per 50 m and keeps 200 m paid ahead of the car, shows what is left, and closes and settles the
  channel when the race ends. The wallet is a testnet key kept in the page, funded from the faucet.
- `web/mpp/` is the fuel server: `pump.ts` (mppx `tempo.session`, fee-paid, testnet) as a Cloudflare Worker with one
  Durable Object (`npm run deploy`), or under Node for a local server (`node serve.ts 8787`).
  `node smoke.mjs <url> <cans>` pays for a race's fuel against it.

Play with it: `node web/mpp/serve.ts 8787`, then open `http://localhost:8080/?tempo=http://localhost:8787/mpp/`.
