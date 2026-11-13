import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN, SCALES } from './setups-builtin.js';
import { validateSetup } from './transfer.js';

test('every built-in setup is valid', () => {
  assert.equal(BUILTIN.length, 5);
  for (const s of BUILTIN) {
    assert.equal(s.builtin, true);
    assert.equal(validateSetup(s), null, s.id);
  }
});

test('every ready scale has 2 to 10 levels', () => {
  for (const s of SCALES) assert.ok(s.levels.length >= 2 && s.levels.length <= 10, s.id);
});

test('built-ins and scales are deeply frozen', () => {
  assert.throws(() => {
    'use strict';
    BUILTIN[1].questions[0].options[0].name = 'x';
  });
  assert.throws(() => {
    'use strict';
    SCALES[0].levels.push('6');
  });
});
