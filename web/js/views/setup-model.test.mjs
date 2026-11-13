import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN } from '../setups-builtin.js';
import { duplicate, fromRun } from './setup-model.js';

const counter = () => {
  let n = 0;
  return () => `new-${++n}`;
};

test('a duplicate gets a new id, a copy name and new option ids and is no longer built in', () => {
  const triage = BUILTIN.find((s) => s.id === 'builtin-triage');
  const copy = duplicate(triage, counter());
  assert.equal(copy.id, 'new-1');
  assert.equal(copy.name, 'Ticket triage copy');
  assert.equal('builtin' in copy, false);
  assert.equal(copy.sampleState, triage.sampleState);
  const team = copy.questions.find((q) => q.key === 'team');
  assert.deepEqual(team.options.map((o) => o.name), triage.questions[0].options.map((o) => o.name));
  assert.ok(team.options.every((o) => o.id.startsWith('new-')));
  assert.ok(copy.questions.find((q) => q.key === 'urgency').levels.every((l) => l.id.startsWith('new-')));
  assert.equal(Object.isFrozen(copy), false);
  copy.questions[0].text = 'changed';
  assert.notEqual(triage.questions[0].text, 'changed');
});

test('a setup made from a run keeps its questions and the situation as the sample', () => {
  const run = {
    state: 'A customer writes in.',
    questions: [
      { key: 'team', type: 'choice', text: 'Who?', options: [{ id: 'a', name: 'x', description: '' }, { id: 'b', name: 'y', description: 'why' }] },
      { key: 'ok', type: 'noul', text: 'Fine?' },
    ],
  };
  const setup = fromRun(run, 'Mine', counter());
  assert.equal(setup.id, 'new-1');
  assert.equal(setup.name, 'Mine');
  assert.equal(setup.sampleState, 'A customer writes in.');
  assert.deepEqual(setup.questions, run.questions);
  setup.questions[0].text = 'changed';
  assert.equal(run.questions[0].text, 'Who?');
});

test('a duplicate of a long name still fits the 60 character limit', () => {
  const copy = duplicate({ name: 'x'.repeat(60), sampleState: '', questions: [] }, counter());
  assert.equal([...copy.name].length, 60);
  assert.ok(copy.name.endsWith(' copy'));
});
