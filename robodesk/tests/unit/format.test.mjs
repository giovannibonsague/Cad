import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, centsToInput, parsePercentToBp, bpToInput, formatBp, parseWholeNumber, parseOptionalNumber, money, fmtBytes, relTime, fmtDate } from '../../src/js/lib/format.js';

test('parseMoney is exact and strict', () => {
  assert.equal(parseMoney('12.34'), 1234);
  assert.equal(parseMoney('$1,234.5'), 123450);
  assert.equal(parseMoney('7'), 700);
  assert.equal(parseMoney('0.1'), 10);
  assert.equal(parseMoney('19.99'), 1999); // 19.99 * 100 is 1998.9999… in floating point
  assert.equal(parseMoney('0.07'), 7);
  assert.equal(parseMoney(''), 0);
  assert.throws(() => parseMoney('', { allowEmpty: false, label: 'Price' }), /Price is required/);
  for (const bad of ['-1', '1.234', 'abc', '1e3', '1,2,3.4x', '12.', '.5', '99999999999']) {
    assert.throws(() => parseMoney(bad), /amount|required/i, bad);
  }
});

test('cents round trip', () => {
  for (const c of [0, 1, 9, 10, 99, 100, 1999, 123456]) assert.equal(parseMoney(centsToInput(c)), c);
  assert.equal(centsToInput(5), '0.05');
  assert.equal(money(123456), '$1,234.56');
});

test('percent <-> basis points', () => {
  assert.equal(parsePercentToBp('8.25'), 825);
  assert.equal(parsePercentToBp('8.25%'), 825);
  assert.equal(parsePercentToBp('100'), 10000);
  assert.equal(parsePercentToBp(''), 0);
  assert.throws(() => parsePercentToBp('100.01'));
  assert.throws(() => parsePercentToBp('-1'));
  assert.throws(() => parsePercentToBp('1.005'));
  assert.equal(bpToInput(825), '8.25');
  assert.equal(bpToInput(800), '8');
  assert.equal(bpToInput(850), '8.5');
  assert.equal(formatBp(0), '0%');
});

test('whole numbers and optional numbers', () => {
  assert.equal(parseWholeNumber('12'), 12);
  assert.throws(() => parseWholeNumber('1.5'));
  assert.throws(() => parseWholeNumber('-3'));
  assert.throws(() => parseWholeNumber('2000000'));
  assert.equal(parseOptionalNumber(''), null);
  assert.equal(parseOptionalNumber('3.3'), 3.3);
  assert.equal(parseOptionalNumber('12'), 12);
  assert.throws(() => parseOptionalNumber('abc'));
  assert.throws(() => parseOptionalNumber('1001'));
  assert.throws(() => parseOptionalNumber('-1'));
  assert.throws(() => parseOptionalNumber('1e2'));
});

test('misc formatting', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.equal(fmtBytes(null), '');
  const now = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(relTime('2026-10-09T11:59:50Z', now), 'just now');
  assert.equal(relTime('2026-10-09T11:00:00Z', now), '1 h ago');
  assert.equal(fmtDate('2026-02-03'), 'Feb 3, 2026');
  assert.equal(fmtDate(''), '');
});
