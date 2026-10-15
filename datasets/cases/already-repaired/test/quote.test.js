import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteOrder } from '../src/quote.js';

test('a coupon can move a cart below the free-shipping threshold', () => {
  assert.deepEqual(quoteOrder({ items: [{ unitCents: 6000, quantity: 1 }], couponPercent: 20 }), {
    subtotalCents: 6000,
    discountCents: 1200,
    shippingCents: 700,
    totalCents: 5500,
  });
});

test('a qualifying cart receives free shipping', () => {
  assert.equal(quoteOrder({ items: [{ unitCents: 5100, quantity: 1 }] }).shippingCents, 0);
});
