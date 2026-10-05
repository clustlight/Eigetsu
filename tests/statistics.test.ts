import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { io as connect } from 'socket.io-client';
import { Coordinator } from '../sfu/coordinator.ts';
import { summarizeTraffic } from '../sfu/statistics.ts';
import type { ControlReply, ControlRequest } from '../sfu/cluster-types.ts';
import type { ClusterStatistics } from '../sfu/statistics-types.ts';
import type { Socket } from 'socket.io-client';

const require = createRequire(new URL('../sfu/package.json', import.meta.url));
const { Server } = require('socket.io');

test('cluster statistics coalesces requests and retains offline and nonresponsive sites without exposing registration secrets', async (t) => {
  const server = createServer();
  const io = new Server(server);
  const secret = 'statistics-test-secret-at-least-32-characters';
  new Coordinator(io, secret, '', 10);
  await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await new Promise<void>((resolve) => io.close(resolve));
  });
  const site = async (id: string) => {
    const socket = connect(`http://127.0.0.1:${(address as AddressInfo).port}/cluster`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: {
        version: 1,
        secret,
        site: { id, url: `https://${id}.example.com`, pipeAddress: '10.1.2.3', instanceId: `private-${id}` },
      },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const request = async <T = unknown>(action: ControlRequest): Promise<T> => {
      const reply = await socket.timeout(6000).emitWithAck('request', action);
      assert.equal(reply.ok, true);
      return reply.value as T;
    };
    await request({ action: 'register', rooms: [] });
    return { socket, request };
  };
  const a = await site('a');
  const b = await site('b');
  const c = await site('c');
  await site('slow');
  b.socket.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 40));
  let samples = 0;
  a.socket.on('statistics', (reply: (reply: ControlReply) => void) => {
    samples++;
    reply({ ok: true, value: { sampledAt: Date.now(), peers: 1 } });
  });
  c.socket.on('statistics', (reply: (reply: ControlReply) => void) =>
    reply({ ok: false, error: 'worker unavailable' }),
  );
  await a.request({ action: 'join', peerId: 'peer-a', name: 'private participant' });
  const [first, second] = await Promise.all([
    a.request<ClusterStatistics>({ action: 'statistics' }),
    c.request<ClusterStatistics>({ action: 'statistics' }),
  ]);
  assert.deepEqual(first, second);
  assert.equal(samples, 1);
  assert.equal(first.rooms, 1);
  assert.equal(first.peers, 1);
  assert.deepEqual(
    first.sites.map(({ id, status }) => [id, status]),
    [
      ['a', 'online'],
      ['b', 'offline'],
      ['c', 'unavailable'],
      ['slow', 'unavailable'],
    ],
  );
  assert.equal(first.sites[1].metrics, null);
  assert.deepEqual(await a.request({ action: 'statistics' }), first);
  assert.equal(samples, 1);
  const json = JSON.stringify(first);
  for (const value of [secret, '10.1.2.3', 'private-a', 'private participant']) assert.ok(!json.includes(value));
});

test('traffic totals distinguish missing samples from measured idle transports', () => {
  assert.deepEqual(
    summarizeTraffic([
      [{ recvBitrate: 10, sendBitrate: 20, bytesReceived: 100, bytesSent: 200 }],
      [],
      [{ recvBitrate: 0, sendBitrate: 0, bytesReceived: 0, bytesSent: 0 }],
    ]),
    { transports: 3, unavailable: 1, receiveBps: 10, sendBps: 20, bytesReceived: 100, bytesSent: 200 },
  );
});
