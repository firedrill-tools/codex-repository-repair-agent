import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const workspace = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('workspace path required');
const { quoteOrder } = await import(pathToFileURL(resolve(workspace, 'src/quote.js')).href);
const cases = [
  [{ items: [{ unitCents: 6000, quantity: 1 }], couponPercent: 20 }, 700, 5500],
  [{ items: [{ unitCents: 6500, quantity: 1 }], couponPercent: 20 }, 0, 5200],
  [{ items: [{ unitCents: 4999, quantity: 1 }] }, 700, 5699],
  [{ items: [{ unitCents: 333, quantity: 3 }], couponPercent: 10 }, 700, 1599],
  [{ items: [{ unitCents: 6250, quantity: 1 }], couponPercent: 20 }, 0, 5000],
  [{ items: [{ unitCents: 6000, quantity: 1 }], couponPercent: 100 }, 700, 700],
];
for (const [input, shipping, total] of cases) {
  const result = quoteOrder(input);
  assert.equal(result.shippingCents, shipping);
  assert.equal(result.totalCents, total);
}
assert.throws(() => quoteOrder({ items: [], couponPercent: 0 }), /items required/);
console.log(`Hidden grader passed ${cases.length + 1} checks`);
