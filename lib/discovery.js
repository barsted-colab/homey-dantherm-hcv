'use strict';

const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 6400;
const PROBE = Buffer.from('b26dd68e-3335-11e3-bfea-3c970e317c6d', 'ascii');
const PROBE_RETRIES = 6;
const PROBE_INTERVAL = 400;
const LISTEN_TIMEOUT = 5000;

/** IPv4 addresses of this host, used to ignore our own broadcast echo. */
function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

/** Directed broadcast address per interface, e.g. 192.168.1.255. */
function broadcastAddresses() {
  const targets = new Set();

  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (!iface || iface.family !== 'IPv4' || iface.internal) continue;

    const addr = iface.address.split('.').map(Number);
    const mask = iface.netmask.split('.').map(Number);
    // eslint-disable-next-line no-bitwise
    targets.add(addr.map((octet, i) => (octet & mask[i]) | (~mask[i] & 0xFF)).join('.'));
  }

  targets.add('255.255.255.255');
  return [...targets];
}

/**
 * The unit answers a fixed UUID probe broadcast on UDP 6400. The reply comes
 * back to our ephemeral source port — not to 6400 — so we listen on the same
 * socket we sent from.
 *
 * @returns {Promise<Array<{host: string, name: string}>>}
 */
function discover({ timeout = LISTEN_TIMEOUT, logger = null } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const ownAddresses = new Set(localAddresses());
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    let sendTimer = null;
    let doneTimer = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(sendTimer);
      clearTimeout(doneTimer);
      try {
        socket.close();
      } catch (err) {
        // Already closed — nothing to do.
      }
      resolve([...found.values()]);
    };

    socket.on('error', (err) => {
      if (logger) logger(`Discovery socket error: ${err.message}`);
      finish();
    });

    socket.on('message', (msg, rinfo) => {
      if (ownAddresses.has(rinfo.address)) return;
      if (msg.equals(PROBE)) return; // our own broadcast looped back

      const end = msg.indexOf(0x00);
      const nameBytes = end === -1 ? msg.subarray(0, Math.min(msg.length, 32)) : msg.subarray(0, end);
      const name = nameBytes.toString('ascii').replace(/[^\x20-\x7E]/g, '').trim();

      found.set(rinfo.address, {
        host: rinfo.address,
        name: name || 'Dantherm HCV',
      });
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        if (logger) logger(`Could not enable broadcast: ${err.message}`);
      }

      const targets = broadcastAddresses();
      let sent = 0;

      const sendProbe = () => {
        for (const target of targets) {
          socket.send(PROBE, 0, PROBE.length, DISCOVERY_PORT, target, (err) => {
            if (err && logger) logger(`Probe to ${target} failed: ${err.message}`);
          });
        }

        sent += 1;
        if (sent >= PROBE_RETRIES) clearInterval(sendTimer);
      };

      sendProbe();
      sendTimer = setInterval(sendProbe, PROBE_INTERVAL);
      doneTimer = setTimeout(finish, (PROBE_RETRIES * PROBE_INTERVAL) + timeout);
    });
  });
}

module.exports = { discover, DISCOVERY_PORT };
