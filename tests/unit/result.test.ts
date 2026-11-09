import { describe, expect, test } from 'bun:test';
import { err, ok } from '../../src/lib/result';

describe('Result', () => {
  test('ok carries a value', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  test('err carries an error code', () => {
    expect(err('wrong_password')).toEqual({ ok: false, error: 'wrong_password' });
  });
});
