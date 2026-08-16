'use strict';

const net = require('net');

const MBAP_LENGTH = 7;
const PROTOCOL_ID = 0;

const FC_READ_HOLDING = 0x03;
const FC_WRITE_MULTIPLE = 0x10;

const EXCEPTIONS = {
  1: 'Illegal function',
  2: 'Illegal data address',
  3: 'Illegal data value',
  4: 'Slave device failure',
  5: 'Acknowledge',
  6: 'Slave device busy',
  8: 'Memory parity error',
  10: 'Gateway path unavailable',
  11: 'Gateway target device failed to respond',
};

/**
 * Minimal Modbus TCP client covering FC3 (read holding registers) and
 * FC16 (write multiple registers) — the only two function codes the
 * Dantherm controller needs.
 *
 * Requests are serialised through a promise chain: the controller is a small
 * embedded device and pipelining transactions to it is a good way to get
 * truncated replies.
 */
class ModbusTCP {

  constructor({ host, port = 502, unitId = 1, timeout = 3000 }) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.timeout = timeout;

    this._socket = null;
    this._connected = false;
    this._transactionId = 0;
    this._rxBuffer = Buffer.alloc(0);
    this._pending = null;
    this._queue = Promise.resolve();
  }

  get connected() {
    return this._connected;
  }

  connect() {
    if (this._connected) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;

      const failConnect = (err) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };

      const connectTimer = setTimeout(
        () => failConnect(new Error(`Connection to ${this.host}:${this.port} timed out`)),
        this.timeout,
      );

      socket.once('connect', () => {
        clearTimeout(connectTimer);
        if (settled) return;
        settled = true;

        socket.setNoDelay(true);
        this._socket = socket;
        this._connected = true;
        this._rxBuffer = Buffer.alloc(0);
        resolve();
      });

      socket.on('error', (err) => {
        clearTimeout(connectTimer);
        if (!settled) return failConnect(err);
        this._teardown(err);
      });

      socket.on('close', () => {
        if (!settled) return;
        this._teardown(new Error('Connection closed'));
      });

      socket.on('data', (chunk) => this._onData(chunk));

      socket.connect(this.port, this.host);
    });
  }

  disconnect() {
    const socket = this._socket;
    this._connected = false;
    this._socket = null;
    this._rejectPending(new Error('Disconnected'));
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  _teardown(err) {
    this._connected = false;
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
    this._rejectPending(err);
  }

  _rejectPending(err) {
    if (!this._pending) return;
    const { reject, timer } = this._pending;
    this._pending = null;
    clearTimeout(timer);
    reject(err);
  }

  _onData(chunk) {
    this._rxBuffer = Buffer.concat([this._rxBuffer, chunk]);

    // A single TCP segment may hold a partial ADU or several of them, so
    // drain the buffer frame by frame using the MBAP length field.
    while (this._rxBuffer.length >= MBAP_LENGTH) {
      const length = this._rxBuffer.readUInt16BE(4);
      const frameLength = 6 + length;
      if (this._rxBuffer.length < frameLength) break;

      const frame = this._rxBuffer.subarray(0, frameLength);
      this._rxBuffer = this._rxBuffer.subarray(frameLength);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    const pending = this._pending;
    if (!pending) return;

    const transactionId = frame.readUInt16BE(0);
    if (transactionId !== pending.transactionId) {
      // Stale reply from a timed-out transaction — drop it rather than
      // resolving the current request with the wrong payload.
      return;
    }

    this._pending = null;
    clearTimeout(pending.timer);

    const fc = frame.readUInt8(7);
    const pdu = frame.subarray(8);

    if (fc & 0x80) {
      const code = pdu.readUInt8(0);
      const name = EXCEPTIONS[code] || `Unknown exception ${code}`;
      return pending.reject(new Error(`Modbus exception ${code}: ${name}`));
    }

    if (fc !== pending.fc) {
      return pending.reject(new Error(`Unexpected function code ${fc}, expected ${pending.fc}`));
    }

    return pending.resolve(pdu);
  }

  _nextTransactionId() {
    this._transactionId = (this._transactionId + 1) & 0xFFFF;
    return this._transactionId;
  }

  _request(fc, payload) {
    // Chain onto the queue so only one transaction is in flight at a time.
    const run = () => this._send(fc, payload);
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }

  async _send(fc, payload) {
    if (!this._connected) await this.connect();

    // The socket can still drop between connect() resolving and the write
    // below — an unguarded write would throw a TypeError instead of a
    // recoverable Modbus error.
    if (!this._socket) throw new Error('Not connected');

    return new Promise((resolve, reject) => {
      const transactionId = this._nextTransactionId();
      const pdu = Buffer.concat([Buffer.from([fc]), payload]);

      const header = Buffer.alloc(MBAP_LENGTH);
      header.writeUInt16BE(transactionId, 0);
      header.writeUInt16BE(PROTOCOL_ID, 2);
      header.writeUInt16BE(pdu.length + 1, 4); // unit id + pdu
      header.writeUInt8(this.unitId, 6);

      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error(`Modbus request timed out after ${this.timeout} ms`));
      }, this.timeout);

      this._pending = { transactionId, fc, resolve, reject, timer };

      this._socket.write(Buffer.concat([header, pdu]), (err) => {
        if (!err) return;
        this._rejectPending(err);
      });
    });
  }

  /**
   * FC3 — read `count` consecutive holding registers starting at `address`.
   * @returns {Promise<number[]>} raw 16-bit register values, in wire order
   */
  async readHoldingRegisters(address, count) {
    const payload = Buffer.alloc(4);
    payload.writeUInt16BE(address, 0);
    payload.writeUInt16BE(count, 2);

    const pdu = await this._request(FC_READ_HOLDING, payload);
    const byteCount = pdu.readUInt8(0);

    if (byteCount !== count * 2) {
      throw new Error(`Expected ${count * 2} bytes, got ${byteCount}`);
    }

    const registers = [];
    for (let i = 0; i < count; i++) {
      registers.push(pdu.readUInt16BE(1 + i * 2));
    }
    return registers;
  }

  /**
   * FC16 — write consecutive holding registers starting at `address`.
   * @param {number[]} registers raw 16-bit values, in wire order
   */
  async writeMultipleRegisters(address, registers) {
    const payload = Buffer.alloc(5 + registers.length * 2);
    payload.writeUInt16BE(address, 0);
    payload.writeUInt16BE(registers.length, 2);
    payload.writeUInt8(registers.length * 2, 4);
    registers.forEach((value, i) => payload.writeUInt16BE(value & 0xFFFF, 5 + i * 2));

    await this._request(FC_WRITE_MULTIPLE, payload);
  }

}

module.exports = ModbusTCP;
