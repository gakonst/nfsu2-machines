// Tempo fuel's sums (runtime/mppfuel.c meters a race, mppfuel.ts pays for it): kept apart so the tests reach them
// without a wallet.  One can of fuel is one MPP session voucher of PRICE; the page keeps AHEAD_M of fuel paid in
// front of the car, so a voucher lands well before the car would reach the end of what it holds.
export const PRICE = 0.001;
export const METERS_PER_CAN = 50;
export const AHEAD_M = 200;

/** cans to buy now, with driven metres driven and paid metres paid (both this race's) */
export function cansDue(driven: number, paid: number): number {
  const left = paid - Math.max(0, driven);
  return left >= AHEAD_M ? 0 : Math.ceil((AHEAD_M - left) / METERS_PER_CAN);
}

/** a race's spend in dollars, from its cans */
export const spend = (cans: number) => Math.round(cans * PRICE * 1e6) / 1e6;
