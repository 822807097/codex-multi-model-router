import test from 'node:test';
import assert from 'node:assert/strict';

import { RequestBudget } from '../lib/request-budget.mjs';

test('请求预算同时限制活跃请求数和缓冲总字节', () => {
  const budget = new RequestBudget({ maxActive: 2, maxBytes: 10 });
  const first = budget.acquire();
  const second = budget.acquire();
  assert.ok(first);
  assert.ok(second);
  assert.equal(budget.acquire(), null);

  assert.equal(budget.add(first, 6), true);
  assert.equal(budget.add(second, 4), true);
  assert.equal(budget.add(second, 1), false);
  assert.equal(budget.bytes, 10);
});

test('释放和丢弃预算幂等且不会出现负数', () => {
  const budget = new RequestBudget({ maxActive: 1, maxBytes: 10 });
  const token = budget.acquire();
  budget.add(token, 8);
  budget.discardBytes(token);
  assert.equal(budget.bytes, 0);
  assert.equal(budget.active, 1);

  budget.release(token);
  budget.release(token);
  assert.equal(budget.bytes, 0);
  assert.equal(budget.active, 0);
});
