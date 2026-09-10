import assert from 'node:assert/strict';
import test from 'node:test';

import { selectCombinedCronJob } from '../combined-cron.mjs';

test('combined cron dispatches Alcopa at 02 UTC and Interencheres in the evening', () => {
  assert.equal(selectCombinedCronJob(new Date('2026-09-10T02:15:00Z'), 'auto'), 'alcopa');
  assert.equal(selectCombinedCronJob(new Date('2026-09-10T16:15:00Z'), 'auto'), 'interencheres');
  assert.equal(selectCombinedCronJob(new Date('2026-09-10T18:15:00Z'), ''), 'interencheres');
});

test('combined cron accepts an explicit job for manual Railway runs', () => {
  assert.equal(selectCombinedCronJob(new Date('2026-09-10T12:00:00Z'), 'alcopa'), 'alcopa');
  assert.equal(selectCombinedCronJob(new Date('2026-09-10T12:00:00Z'), 'interencheres'), 'interencheres');
  assert.throws(
    () => selectCombinedCronJob(new Date('2026-09-10T12:00:00Z'), 'unknown'),
    /COMBINED_CRON_JOB invalide/,
  );
});
