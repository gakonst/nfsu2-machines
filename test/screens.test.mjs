// Screenshots of the page in headless Chromium (playwright, not a repo dependency):
//   MM_URL=http://localhost:8787 MM_SHOTS=/tmp/mm-shots PLAYWRIGHT=/tmp/pw/node_modules/playwright/index.mjs node --test test/screens.test.mjs
// Skipped unless MM_SHOTS is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const BASE = process.env.MM_URL, OUT = process.env.MM_SHOTS;

test('menu, single race, drag race', { skip: !BASE || !OUT }, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.mm?.machine);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/menu.png' });
  await page.click('#go-single');
  await page.screenshot({ path: OUT + '/single-options.png' });
  await page.click('#single-start');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/countdown.png' });
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(6000);
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + '/race.png' });
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('ArrowUp');
  // drag: launch, shift near the light
  await page.evaluate(() => { Object.assign(window.mm.opts, { mode: 2, track: 1, bots: 3 }); window.mm.startSingle(); });
  await page.waitForTimeout(3100);
  await page.keyboard.down('ArrowUp');
  let shot = false;
  for (let i = 0; i < 300 && !shot; i++) {
    const rpm = await page.evaluate(() => { const m = window.mm.machine, s = m.state(); return m.car(s, 0, 4); });
    if (rpm >= 6900) {
      await page.keyboard.press('KeyE');
      await page.waitForTimeout(150);
      if (i > 20) { await page.screenshot({ path: OUT + '/drag.png' }); shot = true; }
    }
    await page.waitForTimeout(30);
  }
  if (!shot) await page.screenshot({ path: OUT + '/drag.png' });
  // drive the drag race to the end: results table
  for (let i = 0; i < 400; i++) {
    const [phase, rpm] = await page.evaluate(() => { const m = window.mm.machine, s = m.state(); return [s[0], m.car(s, 0, 4)]; });
    if (phase === 2) break;
    if (rpm >= 6900) await page.keyboard.press('KeyE');
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/results.png' });
  await page.keyboard.up('ArrowUp');
  assert.equal(await page.evaluate(() => window.mm.machine.state()[0]), 2, 'drag race finished');
  // two browsers race each other in one room
  const code = 'SHOT' + String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const host = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const guest = await browser.newPage({ viewport: { width: 960, height: 540 } });
  for (const [p, name] of [[host, 'Host'], [guest, 'Guest']]) {
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(BASE + '/?room=' + code);
    await p.waitForFunction(() => window.mm?.machine);
    await p.fill('#mp-name', name);
    await p.click('#mp-join');
    await p.waitForFunction(() => window.mm.room?.conn.client.you >= 0);
  }
  await host.waitForFunction(() => window.mm.room.conn.client.players.length === 2);
  await host.evaluate(() => Object.assign(window.mm.opts, { mode: 0, track: 4, laps: 1, bots: 4 }));
  await host.click('#lobby-start');
  await guest.waitForFunction(() => window.mm.run === 'net');
  await guest.keyboard.down('ArrowUp');
  await host.keyboard.down('ArrowUp');
  await host.waitForTimeout(6000);
  await host.screenshot({ path: OUT + '/mp-host.png' });
  await guest.screenshot({ path: OUT + '/mp-guest.png' });
  for (const p of [host, guest]) {
    const st = await p.evaluate(() => { const c = window.mm.room.conn.client; return { desync: c.desync, frame: c.frame, hashes: c.myHashes.size }; });
    assert.equal(st.desync, null);
    assert.ok(st.frame > 80, 'frames applied ' + st.frame);
    assert.ok(st.hashes > 0);
  }
  await page.keyboard.up('ArrowUp');
  // multiplayer lobby (a room of one)
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.mm?.machine);
  await page.click('#go-multi');
  await page.fill('#mp-name', 'Night Owl');
  await page.click('#mp-create');
  await page.waitForSelector('#lobby-players li');
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/lobby.png' });
  // a phone in landscape: touch buttons
  const phone = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(BASE + '/');
  await phone.waitForFunction(() => window.mm?.machine);
  await phone.evaluate(() => { Object.assign(window.mm.opts, { mode: 1, track: 2, bots: 5 }); window.mm.startSingle(); });
  await phone.waitForTimeout(4000);
  await phone.screenshot({ path: OUT + '/phone.png' });
  await browser.close();
  assert.deepEqual(errors, []);
});
