import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { io as connect } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { Coordinator } from '../sfu/coordinator.ts';
import type { ControlRequest, RoomSnapshot } from '../sfu/cluster-types.ts';

const require = createRequire(new URL('../sfu/package.json', import.meta.url));
const { Server } = require('socket.io');
const secret = 'persistence-test-secret-at-least-32-characters';

async function createCoordinator(stateFile: string) {
  const server = createServer();
  const io = new Server(server);
  const coordinator = new Coordinator(io, secret, stateFile, 60_000);
  await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
  const address = server.address() as AddressInfo;
  return {
    coordinator,
    io,
    url: `http://127.0.0.1:${address.port}/cluster`,
    close: () => new Promise<void>((resolve) => io.close(resolve)),
  };
}

async function connectSite(url: string, id: string, instanceId: string) {
  const socket = connect(url, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: {
      version: 1,
      secret,
      site: { id, url: `https://${id}.example.com`, pipeAddress: '127.0.0.1', instanceId },
    },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const request = async <T = unknown>(command: ControlRequest): Promise<T> => {
    const response = await socket.timeout(1000).emitWithAck('request', command);
    if (!response.ok) throw new Error(response.error);
    return response.value as T;
  };
  return { socket, request };
}

test('coordinator persists room metadata atomically and restores it after restart', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eigetsu-coordinator-'));
  const stateFile = path.join(directory, 'rooms.json');
  const resources: {
    first?: Awaited<ReturnType<typeof createCoordinator>>;
    firstSocket?: Socket;
    second?: Awaited<ReturnType<typeof createCoordinator>>;
    recoveredSocket?: Socket;
  } = {};
  t.after(async () => {
    resources.firstSocket?.disconnect();
    resources.recoveredSocket?.disconnect();
    if (resources.first) await resources.first.close();
    if (resources.second) await resources.second.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await createCoordinator(stateFile);
  resources.first = first;
  const site = await connectSite(first.url, 'tokyo', 'instance-1');
  resources.firstSocket = site.socket;
  await site.request({ action: 'register', rooms: [] });
  const room = await site.request<RoomSnapshot>({ action: 'join', peerId: 'alice', name: 'Alice' });
  await site.request({ action: 'voice', roomId: room.id, peerId: 'alice', enabled: true });
  await site.request({
    action: 'publish',
    roomId: room.id,
    peerId: 'alice',
    share: { id: 'screen-1', kind: 'video', label: 'Screen', appData: {} },
  });

  const saved = JSON.parse(await readFile(stateFile, 'utf8')) as {
    version: number;
    rooms: RoomSnapshot[];
    sites: Array<{ id: string; instanceId: string }>;
  };
  assert.equal(saved.version, 1);
  assert.equal(saved.rooms[0].voiceChatEnabled, true);
  assert.equal(saved.rooms[0].peers[0].shares[0].id, 'screen-1');
  assert.equal(saved.sites[0].id, 'tokyo');
  assert.equal(
    await readFile(`${stateFile}.tmp`, 'utf8').then(
      () => true,
      () => false,
    ),
    false,
  );

  site.socket.disconnect();
  resources.firstSocket = undefined;
  await first.close();
  resources.first = undefined;

  const second = await createCoordinator(stateFile);
  resources.second = second;
  const restored = second.coordinator.rooms.get(room.id);
  assert.ok(restored, 'room should be restored from the state file');
  assert.equal(restored.name, room.name);
  assert.equal(restored.voiceChatEnabled, true);
  assert.equal(restored.peers[0].id, 'alice');
  assert.equal(restored.peers[0].siteId, 'tokyo');
  assert.equal(restored.peers[0].shares[0].id, 'screen-1');

  const recovered = await connectSite(second.url, 'tokyo', 'instance-1');
  resources.recoveredSocket = recovered.socket;
  await recovered.request({
    action: 'register',
    rooms: [
      {
        id: room.id,
        name: room.name,
        peers: [
          { id: 'alice', name: 'Alice', shares: [{ id: 'screen-1', kind: 'video', label: 'Screen', appData: {} }] },
        ],
      },
    ],
  });
  assert.equal(
    second.coordinator.rooms.get(room.id)?.peers.length,
    1,
    'site registration must not duplicate restored peers',
  );
});

test('coordinator rejects an invalid persisted state instead of silently starting empty', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eigetsu-coordinator-invalid-'));
  const stateFile = path.join(directory, 'rooms.json');
  await writeFile(stateFile, JSON.stringify({ version: 2, rooms: [], sites: [] }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const server = createServer();
  const io = new Server(server);
  t.after(() => new Promise<void>((resolve) => io.close(resolve)));
  assert.throws(() => new Coordinator(io, secret, stateFile, 1000), /Invalid master state file/);
});
