import type { ClientEvents, CompatibilityStream, Peer, Producer, Room, ServerEvents, ShareAppData } from './types.js';

import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';

const app = express();
const server = http.createServer(app);
const io = new Server<ClientEvents, ServerEvents>(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 1e6,
});
app.get('/health', (_req, res) => res.json({ status: 'ok', rooms: rooms.size }));
app.get('/internal/rooms', (_req, res) => {
  const now = Date.now();
  res.set('Cache-Control', 'no-store');
  res.json(
    [...rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      peopleCount: room.peers.size,
      expiresAt: room.emptySince ? room.emptySince + ROOM_RETENTION_MS : null,
      remainingMs: room.emptySince ? Math.max(0, room.emptySince + ROOM_RETENTION_MS - now) : null,
    })),
  );
});

const rooms = new Map<string, Room>();
const ROOM_RETENTION_MS = 5 * 60 * 1000;
const workers: mediasoup.types.Worker[] = [];
let nextWorker = 0;
const mediaCodecs: mediasoup.types.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  // Advertise multiple H.264 profiles; the browser negotiates its supported level.
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e034', 'level-asymmetry-allowed': 1 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '4d0034', 'level-asymmetry-allowed': 1 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '640034', 'level-asymmetry-allowed': 1 },
  },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 2 } },
];

async function createWorker() {
  const worker = await mediasoup.createWorker({
    logLevel: (process.env.MEDIASOUP_LOG_LEVEL || 'warn') as mediasoup.types.WorkerLogLevel,
    rtcMinPort: Number(process.env.RTC_MIN_PORT || 40000),
    rtcMaxPort: Number(process.env.RTC_MAX_PORT || 49999),
  });
  worker.on('died', () => {
    console.error('mediasoup worker died; exiting so a process manager can restart it');
    setTimeout(() => process.exit(1), 2000);
  });
  return worker;
}

function pickWorker() {
  const worker = workers[nextWorker++ % workers.length];
  return worker;
}

async function getRoom(roomId: string, roomName?: string) {
  let room = rooms.get(roomId);
  if (room) {
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
    room.emptySince = null;
    return room;
  }
  const router = await pickWorker().createRouter({ mediaCodecs });
  room = {
    id: roomId,
    name: roomName || '配信ルーム',
    router,
    peers: new Map(),
    compatibilityRequests: new Map(),
    compatibilityStreams: new Map(),
    cleanupTimer: null,
    emptySince: null,
  };
  rooms.set(roomId, room);
  return room;
}

function peerInfo(peer: Peer) {
  return {
    id: peer.id,
    name: peer.name,
    shares: [...peer.producers.values()]
      .filter((p) => !p.appData.compatibilityFor)
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        profile: p.appData?.profile,
        label: p.appData?.label || '画面共有',
        appData: p.appData,
      })),
  };
}

async function consumableProducer(room: Room, producerId: string, rtpCapabilities: mediasoup.types.RtpCapabilities) {
  const owner = [...room.peers.values()].find((peer) => peer.producers.has(producerId));
  const original = owner?.producers.get(producerId);
  if (!owner || !original || original.appData.compatibilityFor) throw new Error('共有が終了しています');
  if (room.router.canConsume({ producerId, rtpCapabilities })) return original;
  const supportsBaseline = rtpCapabilities.codecs?.some(
    (codec) =>
      codec.mimeType.toLowerCase() === 'video/h264' &&
      Number(codec.parameters?.['packetization-mode']) === 1 &&
      /^42e0/i.test(String(codec.parameters?.['profile-level-id'] || '')),
  );
  if (original.kind !== 'video' || !supportsBaseline) throw new Error('この端末が受信できる映像形式がありません');
  if (!original.appData.compatibilitySupported) throw new Error('送信側を更新し、画面共有を開始し直してください');
  let compatible = room.compatibilityStreams.get(producerId)?.producer;
  if (!compatible || compatible.closed) {
    let pending = room.compatibilityRequests.get(producerId);
    if (!pending) {
      pending = new Promise<Producer>((resolve, reject) => {
        const socket = io.sockets.sockets.get(owner.id);
        if (!socket) return reject(new Error('送信側が切断されました'));
        socket.timeout(10000).emit('producer:compatibility-request', { producerId }, (error, result) => {
          if (error) return reject(new Error('送信側の互換配信を開始できませんでした'));
          if (!result?.ok) return reject(new Error(result?.error || '送信側の互換配信を開始できませんでした'));
          const producer = owner.producers.get(result.producerId);
          if (!producer || producer.appData.compatibilityFor !== producerId || original.closed)
            return reject(new Error('共有が終了しています'));
          resolve(producer);
        });
      }).finally(() => room.compatibilityRequests.delete(producerId));
      room.compatibilityRequests.set(producerId, pending);
    }
    compatible = await pending;
  }
  if (!room.router.canConsume({ producerId: compatible.id, rtpCapabilities }))
    throw new Error('この端末は互換配信に対応していません');
  return compatible;
}

io.on('connection', (socket) => {
  let room: Room | undefined;
  let peer: Peer | undefined;
  const transports = new Map<string, mediasoup.types.WebRtcTransport>();
  const producers = new Map<string, Producer>();
  const consumers = new Map<string, mediasoup.types.Consumer>();
  const reply = (callback: unknown, value: Record<string, unknown>) => {
    if (typeof callback === 'function') callback(value);
  };

  socket.on('room:create', async ({ name }, callback) => {
    const id = Math.random().toString(36).slice(2, 8).toUpperCase();
    const creatorName = String(name || 'ゲスト').slice(0, 40);
    try {
      const joinedRoom = await joinRoom(id, creatorName, `${creatorName}の部屋`);
      reply(callback, {
        ok: true,
        roomId: id,
        roomName: joinedRoom.name,
        rtpCapabilities: joinedRoom.router.rtpCapabilities,
        peers: [],
      });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('room:join', async ({ roomId, name }, callback) => {
    try {
      const id = String(roomId || '')
        .trim()
        .toUpperCase();
      if (!id) throw new Error('ルームコードを入力してください');
      const joinedRoom = await joinRoom(id, name || 'ゲスト');
      reply(callback, {
        ok: true,
        roomId: id,
        roomName: joinedRoom.name,
        rtpCapabilities: joinedRoom.router.rtpCapabilities,
        peers: [...joinedRoom.peers.values()].filter((p) => p.id !== socket.id).map(peerInfo),
      });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('room:sync', (callback) => {
    if (!room || !peer) return reply(callback, { ok: false, error: 'Not joined to a room' });
    reply(callback, {
      ok: true,
      peers: [...room.peers.values()].filter((item) => item.id !== socket.id).map(peerInfo),
    });
  });

  async function joinRoom(id: string, name: string, roomName?: string) {
    if (room) throw new Error('すでにルームに参加しています');
    room = await getRoom(id, roomName);
    peer = { id: socket.id, name: String(name).slice(0, 40), producers };
    room.peers.set(socket.id, peer);
    socket.join(id);
    socket.to(id).emit('peer:joined', peerInfo(peer));
    return room;
  }

  socket.on('transport:create', async ({ direction }, callback) => {
    try {
      if (!room) throw new Error('先にルームに参加してください');
      const listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
      const announcedAddress =
        process.env.MEDIASOUP_ANNOUNCED_IP ||
        (listenIp === '0.0.0.0' ? '127.0.0.1' : listenIp === '::' ? '::1' : undefined);
      const transport = await room.router.createWebRtcTransport({
        listenInfos: [
          { protocol: 'udp', ip: listenIp, announcedAddress },
          { protocol: 'tcp', ip: listenIp, announcedAddress },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 30_000_000,
        appData: { direction },
      });
      transports.set(transport.id, transport);
      console.info(
        `[webrtc] transport=${transport.id} direction=${direction} announcedAddress=${announcedAddress} candidates=${JSON.stringify(transport.iceCandidates.map(({ protocol, address, port }) => ({ protocol, address, port })))}`,
      );
      transport.on('icestatechange', (state) => console.info(`[webrtc] transport=${transport.id} ICE=${state}`));
      transport.on('dtlsstatechange', (state) => {
        console.info(`[webrtc] transport=${transport.id} DTLS=${state}`);
        if (state === 'closed') transport.close();
      });
      transport.observer.on('close', () => transports.delete(transport.id));
      reply(callback, {
        ok: true,
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
      });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('transport:connect', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const transport = transports.get(transportId);
      if (!transport) throw new Error('Transport not found');
      await transport.connect({ dtlsParameters });
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('transport:close', ({ transportId }) => {
    const transport = transports.get(transportId);
    if (!transport) return;
    transport.close();
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const transport = transports.get(transportId);
      if (!transport) throw new Error('Transport not found');
      if (!room || !peer) throw new Error('先にルームに参加してください');
      const producerRoom = room;
      const parent = appData?.compatibilityFor ? producers.get(appData.compatibilityFor) : undefined;
      if (
        appData?.compatibilityFor &&
        (!parent || parent.closed || parent.kind !== 'video' || parent.appData.compatibilityFor || kind !== 'video')
      )
        throw new Error('Invalid compatibility source');
      if (parent && room.compatibilityStreams.has(parent.id)) throw new Error('Compatibility stream already exists');
      const producer = await transport.produce<ShareAppData>({
        kind,
        rtpParameters,
        appData: { ...appData, ownerId: socket.id },
      });
      if (parent?.closed) {
        producer.close();
        throw new Error('共有が終了しています');
      }
      producers.set(producer.id, producer);
      if (parent) {
        const state: CompatibilityStream = {
          producer,
          consumers: new Set(),
          timer: null,
          scheduleClose() {
            if (state.timer) clearTimeout(state.timer);
            if (!state.consumers.size) state.timer = setTimeout(() => producer.close(), 10000);
          },
        };
        room.compatibilityStreams.set(parent.id, state);
        state.scheduleClose();
      }
      producer.observer.once('close', () => {
        producers.delete(producer.id);
        if (parent) {
          const state = producerRoom.compatibilityStreams.get(parent.id);
          if (state?.timer) clearTimeout(state.timer);
          producerRoom.compatibilityStreams.delete(parent.id);
          socket.emit('producer:compatibility-stop', { producerId: parent.id });
        } else {
          producerRoom.compatibilityStreams.get(producer.id)?.producer.close();
          socket.to(producerRoom.id).emit('producer:closed', { producerId: producer.id, peerId: socket.id });
        }
      });
      if (!parent)
        socket.to(room.id).emit('producer:new', {
          producerId: producer.id,
          peerId: socket.id,
          peerName: peer.name,
          kind,
          profile: appData?.profile,
          label: appData?.label || '画面共有',
          appData: producer.appData,
        });
      reply(callback, { ok: true, id: producer.id });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    try {
      const transport = transports.get(transportId);
      if (!transport || !room) throw new Error('Transport not found');
      const source = await consumableProducer(room, producerId, rtpCapabilities);
      const consumer = await transport.consume({ producerId: source.id, rtpCapabilities, paused: true });
      consumers.set(consumer.id, consumer);
      const compatibility = source.appData.compatibilityFor
        ? room.compatibilityStreams.get(source.appData.compatibilityFor)
        : undefined;
      if (compatibility) {
        if (compatibility.timer) clearTimeout(compatibility.timer);
        compatibility.consumers.add(consumer.id);
        consumer.observer.once('close', () => {
          compatibility.consumers.delete(consumer.id);
          if (!source.closed) compatibility.scheduleClose();
        });
      }
      consumer.on('transportclose', () => consumers.delete(consumer.id));
      consumer.on('producerclose', () => {
        consumers.delete(consumer.id);
        socket.emit('producer:closed', { producerId });
      });
      reply(callback, {
        ok: true,
        id: consumer.id,
        producerId: source.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused,
        appData: source.appData,
      });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('consumer:resume', async ({ consumerId }, callback) => {
    try {
      const consumer = consumers.get(consumerId);
      if (!consumer) throw new Error('Consumer not found');
      await consumer.resume();
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('consumer:pause', async ({ consumerId }, callback) => {
    try {
      const consumer = consumers.get(consumerId);
      if (!consumer) throw new Error('Consumer not found');
      await consumer.pause();
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('consumer:close', ({ consumerId }) => {
    const consumer = consumers.get(consumerId);
    if (!consumer) return;
    consumers.delete(consumerId);
    consumer.close();
  });

  socket.on('producer:close', ({ producerId }) => {
    const producer = producers.get(producerId);
    if (!producer) return;
    producers.delete(producerId);
    producer.close();
  });

  socket.on('disconnect', () => {
    for (const producer of producers.values()) producer.close();
    for (const consumer of consumers.values()) consumer.close();
    for (const transport of transports.values()) transport.close();
    if (!room) return;
    const disconnectedRoom = room;
    room.peers.delete(socket.id);
    socket.to(room.id).emit('peer:left', { peerId: socket.id });
    if (room.peers.size === 0) {
      room.emptySince = Date.now();
      room.cleanupTimer = setTimeout(() => {
        if (disconnectedRoom.peers.size !== 0 || rooms.get(disconnectedRoom.id) !== disconnectedRoom) return;
        disconnectedRoom.router.close();
        rooms.delete(disconnectedRoom.id);
        console.log(`Room ${disconnectedRoom.id} expired after five minutes without participants`);
      }, ROOM_RETENTION_MS);
      room.cleanupTimer.unref?.();
    }
  });
});

const workerCount = Math.max(1, Number(process.env.MEDIASOUP_WORKERS || 1));
for (let i = 0; i < workerCount; i++) workers.push(await createWorker());
const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`Eigetsu signaling/SFU listening on :${port}`));
