import test from 'node:test';
import assert from 'node:assert/strict';
import { groupModels, presentModel, titleCaseSlug } from '../src/modelPresentation.js';

test('provider-qualified ids become a creator and a clean model name', () => {
  assert.deepEqual(presentModel('openai/gpt-5.2'), {
    id: 'openai/gpt-5.2', creatorKey: 'openai', creatorName: 'OpenAI',
    modelPart: 'gpt-5.2', name: 'GPT 5.2'
  });
  assert.equal(presentModel({ id: 'moonshotai/kimi-k3', name: 'MoonshotAI: Kimi K3' }).creatorName, 'Kimi');
  assert.equal(presentModel({ id: 'moonshotai/kimi-k3', name: 'MoonshotAI: Kimi K3' }).name, 'Kimi K3');
});

test('bare ids use their direct provider as the creator', () => {
  const view = presentModel({ id: 'claude-sonnet-5', provider: 'anthropic' }, 'anthropic');
  assert.equal(view.creatorName, 'Anthropic');
  assert.equal(view.name, 'Claude Sonnet 5');
});

test('models group by creator and sort by display name', () => {
  const groups = groupModels([
    { id: 'openai/gpt-z' }, { id: 'anthropic/claude-b' }, { id: 'openai/gpt-a' }
  ]);
  assert.deepEqual(groups.map(group => group.name), ['Anthropic', 'OpenAI']);
  assert.deepEqual(groups[1].models.map(model => model.presentation.modelPart), ['gpt-a', 'gpt-z']);
  assert.equal(titleCaseSlug('deepseek-chat-v2'), 'Deepseek Chat V2');
});

test('creator aliases share one group', () => {
  const groups = groupModels([
    { id: 'kimi-k2.7-code', provider: 'kimi' },
    { id: 'moonshotai/kimi-k3', provider: 'openrouter' }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'Kimi');
  assert.equal(groups[0].models.length, 2);
});
