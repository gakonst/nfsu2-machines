// Tempo fuel's sums (web/src/app/mppfuel-logic.ts): how many cans keep the car's paid fuel ahead of it
import test from 'node:test';
import assert from 'node:assert/strict';
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const js = (await esbuild.build({ entryPoints: [path.join(ROOT, 'web/src/app/mppfuel-logic.ts')], bundle: true, format: 'esm', write: false, platform: 'neutral' })).outputFiles[0].text;
const { AHEAD_M, METERS_PER_CAN, cansDue, spend } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('a race starts with a full lead bought', () => assert.equal(cansDue(0, 0), AHEAD_M / METERS_PER_CAN));
test('nothing while the lead holds', () => assert.equal(cansDue(100, 100 + AHEAD_M), 0));
test('one can when the car has used under one', () => assert.equal(cansDue(10, AHEAD_M), 1));
test('a car past what it paid buys back to the lead', () => assert.equal(cansDue(500, 300), Math.ceil((AHEAD_M + 200) / METERS_PER_CAN)));
test('spend in dollars, no float dust', () => { assert.equal(spend(3), 0.003); assert.equal(spend(1000), 1); });
