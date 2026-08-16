'use strict';

/**
 * Verifies the CDAB (word-swapped big-endian) codecs against reference values
 * produced by pymodbus' convert_to_registers(..., word_order="little"), which
 * is what the Home Assistant integration uses against real hardware.
 *
 * Run with: node --test test/
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  decodeUInt32, decodeFloat32, decodeUInt64, encodeUInt32, encodeFloat32,
} = require('../lib/dantherm');

test('uint32 round-trips in word-swapped order', () => {
  // pymodbus: convert_to_registers(0x12345678, UINT32, 'little') -> [0x5678, 0x1234]
  assert.deepStrictEqual(encodeUInt32(0x12345678), [0x5678, 0x1234]);
  assert.strictEqual(decodeUInt32([0x5678, 0x1234]), 0x12345678);
});

test('uint32 handles values above 2^31 without sign errors', () => {
  // ACTIVE_MODE commands like END_SUMMER (0x8800) stay small, but the register
  // itself is unsigned 32-bit and must never come back negative.
  assert.strictEqual(decodeUInt32([0xFFFF, 0xFFFF]), 4294967295);
  assert.strictEqual(decodeUInt32([0x0000, 0x8000]), 2147483648);
});

test('float32 matches pymodbus reference encoding', () => {
  // pymodbus: convert_to_registers(21.5, FLOAT32, 'little') -> [0, 16812]
  assert.deepStrictEqual(encodeFloat32(21.5), [0, 16812]);
  assert.strictEqual(decodeFloat32([0, 16812]), 21.5);
});

test('float32 decodes negative outdoor temperatures', () => {
  const registers = encodeFloat32(-12.5);
  assert.strictEqual(decodeFloat32(registers), -12.5);
});

test('float32 is NOT plain little-endian', () => {
  // The classic bug: readFloatLE would give DCBA instead of CDAB.
  const registers = encodeFloat32(21.5);
  const wrong = Buffer.alloc(4);
  wrong.writeUInt16BE(registers[0], 0);
  wrong.writeUInt16BE(registers[1], 2);
  assert.notStrictEqual(wrong.readFloatBE(0), 21.5);
});

test('uint64 serial number decodes with lowest word first', () => {
  // pymodbus: convert_to_registers(0x1122334455667788, UINT64, 'little')
  //           -> [0x7788, 0x5566, 0x3344, 0x1122]
  const registers = [0x7788, 0x5566, 0x3344, 0x1122];
  assert.strictEqual(decodeUInt64(registers), 0x1122334455667788n);
});

test('firmware version 582 decodes to 2.70', () => {
  const fw = 582;
  const formatted = `${(fw >> 8) & 0xFF}.${String(fw & 0xFF).padStart(2, '0')}`;
  assert.strictEqual(formatted, '2.70');
});

test('system id decodes HCV400 device types', () => {
  // Device type lives in the high byte, components in the low word.
  const systemId = (14 << 24) | 0x0044; // HCV400 P1-E1 with bypass + RH sensor
  assert.strictEqual(systemId >>> 24, 14);
  assert.strictEqual(systemId & 0xFFFF, 0x0044);
});
