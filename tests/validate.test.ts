import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateArgs } from '../src/tools/validate.js';

const schema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    count: { type: 'integer' },
    enabled: { type: 'boolean' },
  },
  required: ['path'],
  additionalProperties: false,
};

test('validateArgs accepts valid arguments', () => {
  const result = validateArgs({ path: 'a.txt', count: 2, enabled: true }, schema);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.path, 'a.txt');
  }
});

test('validateArgs rejects missing required arguments', () => {
  const result = validateArgs({ count: 2 }, schema);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /missing required argument "path"/);
  }
});

test('validateArgs rejects unknown arguments', () => {
  const result = validateArgs({ path: 'a', extra: true }, schema);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /unknown argument "extra"/);
  }
});

test('validateArgs rejects wrong types', () => {
  const result = validateArgs({ path: 'a', count: 'not-a-number' }, schema);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /expected integer/);
  }
});

test('validateArgs rejects non-object arguments', () => {
  const result = validateArgs([1, 2], schema);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /must be a JSON object/);
  }
});
