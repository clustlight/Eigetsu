import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { types as Media } from '../sfu/node_modules/mediasoup/node/lib/index.d.ts';
import { io as connect } from 'socket.io-client';
import { installSfuProbe } from '../sfu/probe.ts';

const require = createRequire(new URL('../sfu/package.json', import.meta.url));
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

test('media probes expose site identity, allocate once, and release transports on disconnect', async (t) => {
  const worker: Media.Worker = await mediasoup.createWorker({ rtcMinPort: 44600, rtcMaxPort: 44700 });
  const routers: Media.Router[] = [];
  worker.observer.on('newrouter', (router) => routers.push(router));
  const server = createServer();
  const io = new Server(server);
  let ready = true;
  installSfuProbe(io, worker, 'b', () => ready);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = connect(`http://127.0.0.1:${address.port}/probe`, { transports: ['websocket'], reconnection: false });
  t.after(async () => {
    socket.disconnect();
    await new Promise<void>((resolve) => io.close(resolve));
    worker.close();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const opened = await socket.timeout(1000).emitWithAck('open');
  assert.equal(opened.ok, true);
  assert.equal(opened.siteId, 'b');
  assert.ok(opened.transport.iceCandidates.some((candidate: Media.IceCandidate) => candidate.protocol === 'udp'));
  assert.ok(opened.transport.iceCandidates.some((candidate: Media.IceCandidate) => candidate.protocol === 'tcp'));
  assert.equal((await socket.timeout(1000).emitWithAck('open')).ok, false);
  assert.equal(routers.length, 1);
  assert.equal((await routers[0].dump()).transportIds.length, 1);
  socket.disconnect();
  for (let i = 0; i < 50 && (await routers[0].dump()).transportIds.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await routers[0].dump()).transportIds.length, 0);
  ready = false;
  const unavailable = new Promise<void>((resolve, reject) => {
    socket.once('connect_error', () => resolve());
    socket.once('connect', () => reject(new Error('Unready site accepted a probe')));
  });
  socket.connect();
  await unavailable;
});
