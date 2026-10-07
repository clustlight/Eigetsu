import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { io as connect } from 'socket.io-client';
import { Coordinator } from '../sfu/coordinator.ts';
import type { ControlRequest, RoomSnapshot } from '../sfu/cluster-types.ts';
import type { Socket } from 'socket.io-client';

const require = createRequire(new URL('../sfu/package.json', import.meta.url));
const { Server } = require('socket.io');
const secret = 'test-secret-that-is-at-least-32-characters';

test('master authenticates SFUs, prevents duplicate sites and enforces peer ownership', async (t) => {
  const server = createServer();
  const io = new Server(server);
  new Coordinator(io, secret, '', 50);
  await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${(address as AddressInfo).port}/cluster`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await new Promise<void>((resolve) => io.close(resolve));
  });
  const site = async (id: string, token = secret) => {
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
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const request = async <T = unknown>(command: ControlRequest): Promise<T> => {
      const response = await socket.timeout(1000).emitWithAck('request', command);
      if (!response.ok) throw new Error(response.error);
      return response.value as T;
    };
    await request({ action: 'register', rooms: [] });
    return { socket, request };
  };
  await assert.rejects(site('untrusted', 'incorrect'), /Unauthorized/);
  const a = await site('a');
  const b = await site('b');
  await assert.rejects(site('a'), /already connected/);
  const room = await a.request<{ id: string }>({ action: 'join', peerId: 'alice', name: 'Alice' });
  await b.request({ action: 'join', roomId: room.id, peerId: 'bob', name: 'Bob' });
  const share = { id: 'video-1', kind: 'video' as const, label: 'Screen', appData: {} };
  await assert.rejects(
    b.request({ action: 'publish', roomId: room.id, peerId: 'alice', share }),
    /Participant not found/,
  );
  await a.request({ action: 'publish', roomId: room.id, peerId: 'alice', share });
  const snapshot = await b.request<RoomSnapshot>({ action: 'sync', roomId: room.id });
  assert.equal(snapshot.name, 'Aliceの部屋');
  const alice = snapshot.peers.find((peer) => peer.id === 'alice');
  assert.ok(alice);
  assert.deepEqual(alice.shares, [share]);
  assert.equal(alice.siteId, 'a');
  assert.equal(snapshot.voiceChatEnabled, false);
  const voice = { id: 'voice-1', kind: 'audio' as const, label: 'VC', appData: { voiceChat: true } };
  await assert.rejects(a.request({ action: 'publish', roomId: room.id, peerId: 'alice', share: voice }), /VC/);
  await assert.rejects(
    b.request({ action: 'voice', roomId: room.id, peerId: 'alice', enabled: true }),
    /Participant not found/,
  );
  const updated = new Promise<RoomSnapshot>((resolve) => b.socket.once('room:update', resolve));
  await a.request({ action: 'voice', roomId: room.id, peerId: 'alice', enabled: true });
  assert.equal((await updated).voiceChatEnabled, true);
  await a.request({ action: 'publish', roomId: room.id, peerId: 'alice', share: voice });
  await assert.rejects(
    a.request({ action: 'publish', roomId: room.id, peerId: 'alice', share: { ...voice, id: 'duplicate' } }),
    /already exists/,
  );
  await assert.rejects(
    b.request({ action: 'publish', roomId: room.id, peerId: 'bob', share: { ...voice, kind: 'video' } }),
    /independent audio/,
  );
  await b.request({ action: 'publish', roomId: room.id, peerId: 'bob', share: { ...voice, id: 'voice-2' } });
  const activeVoice = await a.request<RoomSnapshot>({ action: 'sync', roomId: room.id });
  assert.equal(activeVoice.peers.flatMap((peer) => peer.shares).filter((share) => share.appData.voiceChat).length, 2);
  await b.request({ action: 'voice', roomId: room.id, peerId: 'bob', enabled: false });
  const disabledVoice = await a.request<RoomSnapshot>({ action: 'sync', roomId: room.id });
  assert.equal(disabledVoice.voiceChatEnabled, false);
  assert.deepEqual(
    disabledVoice.peers.flatMap((peer) => peer.shares),
    [share],
  );
  await a.request({
    action: 'register',
    rooms: [
      {
        id: room.id,
        name: snapshot.name,
        voiceChatEnabled: true,
        peers: [{ id: 'alice', name: 'Alice', shares: [share, voice] }],
      },
    ],
  });
  const recovered = await b.request<RoomSnapshot>({ action: 'sync', roomId: room.id });
  assert.equal(recovered.voiceChatEnabled, false, 'A stale edge cannot enable VC during re-registration');
  assert.deepEqual(
    recovered.peers.flatMap((peer) => peer.shares),
    [share],
  );
  await a.request({ action: 'leave', roomId: room.id, peerId: 'alice' });
  await b.request({ action: 'leave', roomId: room.id, peerId: 'bob' });
  const listing = await b.request<Array<{ peopleCount: number; remainingMs: number | null }>>({ action: 'rooms' });
  assert.equal(listing[0].peopleCount, 0);
  assert.ok(listing[0].remainingMs !== null && listing[0].remainingMs > 290000);
});
