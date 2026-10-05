import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { io as connect } from 'socket.io-client';
import { Coordinator } from '../sfu/coordinator.ts';

const require = createRequire(new URL('../sfu/package.json', import.meta.url));
const { Server } = require('socket.io');
const secret = 'test-secret-that-is-at-least-32-characters';

test('master authenticates SFUs, prevents duplicate sites and enforces peer ownership', async (t) => {
  const server = createServer();
  const io = new Server(server);
  new Coordinator(io, secret, '', 50);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/cluster`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await new Promise((resolve) => io.close(resolve));
  });
  const site = async (id, token = secret) => {
    const socket = connect(url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: {
        version: 1,
        secret: token,
        site: { id, url: `https://${id}.example.com`, pipeAddress: '127.0.0.1', instanceId: id },
      },
    });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const request = async (command) => {
      const response = await socket.timeout(1000).emitWithAck('request', command);
      if (!response.ok) throw new Error(response.error);
      return response.value;
    };
    await request({ action: 'register', rooms: [] });
    return { socket, request };
  };
  await assert.rejects(site('untrusted', 'incorrect'), /Unauthorized/);
  const a = await site('a');
  const b = await site('b');
  await assert.rejects(site('a'), /already connected/);
  const room = await a.request({ action: 'join', peerId: 'alice', name: 'Alice' });
  await b.request({ action: 'join', roomId: room.id, peerId: 'bob', name: 'Bob' });
  const share = { id: 'video-1', kind: 'video', label: 'Screen', appData: {} };
  await assert.rejects(
    b.request({ action: 'publish', roomId: room.id, peerId: 'alice', share }),
    /Participant not found/,
  );
  await a.request({ action: 'publish', roomId: room.id, peerId: 'alice', share });
  const snapshot = await b.request({ action: 'sync', roomId: room.id });
  assert.equal(snapshot.name, 'Aliceの部屋');
  assert.deepEqual(snapshot.peers.find((peer) => peer.id === 'alice').shares, [share]);
  assert.equal(snapshot.peers.find((peer) => peer.id === 'alice').siteId, 'a');
  await a.request({ action: 'leave', roomId: room.id, peerId: 'alice' });
  await b.request({ action: 'leave', roomId: room.id, peerId: 'bob' });
  const listing = await b.request({ action: 'rooms' });
  assert.equal(listing[0].peopleCount, 0);
  assert.ok(listing[0].remainingMs > 290000);
});
