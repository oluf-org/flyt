import test from 'node:test';
import assert from 'node:assert/strict';
import {
  workerForTier, workflowModelSelection,
} from '../src/modelTiers.js';

const fallback = { provider: 'auto', model: 'ordinary' };
const flash = { provider: 'auto', model: 'new-flash' };

test('several model profiles can intentionally resolve to one unusually good cheap model', () => {
  const tiers = { economy: flash, standard: flash, frontier: flash };
  assert.equal(workerForTier(tiers, 'economy', fallback).model, 'new-flash');
  assert.equal(workerForTier(tiers, 'standard', fallback).model, 'new-flash');
  assert.equal(workerForTier(tiers, 'frontier', fallback).model, 'new-flash');
});

test('workflow blocks inherit a profile, choose another profile, or pin one specific model', () => {
  const selection = workflowModelSelection({
    tiers: {
      free: [
        { provider: 'auto', model: 'free-model' },
        { provider: 'auto', model: 'backup-free' },
      ],
      economy: { provider: 'auto', model: 'cheap-model' },
      standard: fallback,
    },
    defaultTier: 'standard',
    blockTiers: { refine: 'economy', plan: 'free' },
    customBlocks: { work: { provider: 'auto', model: 'strong-model' } },
    fallback,
  });
  assert.deepEqual(selection, {
    defaultWorker: fallback,
    defaultFallbacks: [],
    blocks: {
      refine: { provider: 'auto', model: 'cheap-model' },
      plan: { provider: 'auto', model: 'free-model' },
      work: { provider: 'auto', model: 'strong-model' },
    },
    blockFallbacks: {
      plan: [{ provider: 'auto', model: 'backup-free' }],
    },
  });
});

test('Free is an ordered free-only chain and does not inherit the paid executor', () => {
  const free = [
    { provider: 'one', model: 'free-primary' },
    { provider: 'two', model: 'free-backup' },
  ];
  assert.deepEqual(workflowModelSelection({
    tiers: { free }, defaultTier: 'free', fallback,
  }), {
    defaultWorker: free[0],
    defaultFallbacks: [free[1]],
    blocks: {},
    blockFallbacks: {},
  });
});

test('an unconfigured Free profile never silently falls back to a paid default', () => {
  assert.equal(workerForTier({}, 'free', fallback), null);
});

test('authored workflow tiers apply until a project overrides them', () => {
  const tiers = {
    free: [{ provider: 'auto', model: 'free-one' }, { provider: 'auto', model: 'free-two' }],
    frontier: { provider: 'auto', model: 'best-planner' },
    standard: fallback,
  };
  const selection = workflowModelSelection({
    tiers, fallback,
    defaultBlockTiers: { refine: 'free', plan: 'frontier', work: 'standard' },
    blockTiers: { work: 'frontier' },
  });
  assert.equal(selection.blocks.refine.model, 'free-one');
  assert.equal(selection.blockFallbacks.refine[0].model, 'free-two');
  assert.equal(selection.blocks.plan.model, 'best-planner');
  assert.equal(selection.blocks.work.model, 'best-planner');
});
