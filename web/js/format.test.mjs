import assert from 'node:assert/strict';
import test from 'node:test';
import { noulIsYes, nearestLevel, pct, prob, signed, stepPlace, stepText } from './format.js';

test('prob has two decimals', () => {
  assert.equal(prob(0.805), '0.81');
  assert.equal(prob(0), '0.00');
  assert.equal(prob(1), '1.00');
});

test('pct rounds and uses a non-breaking space', () => {
  assert.equal(pct(0.4725), '47 %');
  assert.equal(pct(0), '0 %');
});

test('stepText counts from 1 with one decimal', () => {
  assert.equal(stepText(2.2296282454039096), '3.2');
  assert.equal(stepText(0), '1.0');
});

test('stepPlace names the step and the number of steps', () => {
  assert.equal(stepPlace(0.7, 2), 'step 1.7 of 2');
});

test('nearestLevel rounds half to even and clamps', () => {
  assert.equal(nearestLevel(2.23, 4), 2);
  assert.equal(nearestLevel(2.5, 4), 2);
  assert.equal(nearestLevel(1.5, 4), 2);
  assert.equal(nearestLevel(0.5, 4), 0);
  assert.equal(nearestLevel(3.5, 4), 3);
  assert.equal(nearestLevel(-0.2, 4), 0);
  assert.equal(nearestLevel(9, 4), 3);
});

test('noulIsYes is yes from 0.5', () => {
  assert.equal(noulIsYes(0.5), true);
  assert.equal(noulIsYes(0.4999), false);
});

test('signed uses a true minus sign', () => {
  assert.equal(signed(-0.4), '−0.40');
  assert.equal(signed(0.12), '+0.12');
  assert.equal(signed(0), '0.00');
  assert.equal(signed(-0.001), '0.00');
});
