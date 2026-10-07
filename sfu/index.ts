import type { ClientEvents, CompatibilityStream, Peer, Producer, Room, ServerEvents, ShareAppData } from './types.js';

import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';
import { readClusterConfig } from './cluster-config.ts';
import { ClusterClient } from './cluster-client.ts';
import { Coordinator } from './coordinator.ts';
import { Federation, type ProducerLease } from './federation.ts';
import type { RoomSnapshot } from './cluster-types.js';
import { createStatisticsCollector } from './statistics.ts';
import { createWebRtcTransport } from './webrtc-transport.ts';
import { installSfuProbe } from './probe.ts';
import { ShareRouting, ShareWorkerPool } from './share-routing.ts';

const config = readClusterConfig();

const app = express();
const server = http.createServer(app);
const io = new Server<ClientEvents, ServerEvents>(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 1e6,
});
const rooms = new Map<string, Room>();
const pendingRooms = new Map<string, Promise<Room>>();
const roomSnapshots = new Map<string, RoomSnapshot>();
const ROOM_RETENTION_MS = 5 * 60 * 1000;
if (config.role !== 'sfu') new Coordinator(io, config.secret, config.stateFile, config.siteGraceMs);
const cluster: ClusterClient = new ClusterClient(config.masterUrl, config.secret, config.site, () =>
  [...rooms.values()]
    .filter((room) => room.peers.size)
    .map((room) => ({
      id: room.id,
      name: room.name,
      voiceChatEnabled: cluster.rooms.get(room.id)?.voiceChatEnabled === true,
      peers: [...room.peers.values()].map(peerInfo),
    })),
);
const federation = new Federation({ cluster, rooms, listenIp: config.pipeListenIp, resolveLocal: consumableProducer });
federation.onRetry = (roomId, producerId) => {
  const peer = cluster.rooms.get(roomId)?.peers.find((peer) => peer.shares.some((share) => share.id === producerId));
  const share = peer?.shares.find((share) => share.id === producerId);
  if (peer && share) io.to(roomId).emit('producer:new', { ...share, producerId, peerId: peer.id, peerName: peer.name });
};
cluster.onRoom = (snapshot) => {
  const previous = roomSnapshots.get(snapshot.id);
  roomSnapshots.set(snapshot.id, snapshot);
  const local = rooms.get(snapshot.id);
  if (local) local.name = snapshot.name;
  const voiceChatEnabled = snapshot.voiceChatEnabled === true;
  if (!voiceChatEnabled && local)
    for (const peer of local.peers.values())
      for (const producer of peer.producers.values()) if (producer.appData.voiceChat) producer.close();
  if (previous?.voiceChatEnabled !== snapshot.voiceChatEnabled)
    io.to(snapshot.id).emit('room:voice', { voiceChatEnabled });
  for (const peer of previous?.peers || []) {
    const next = snapshot.peers.find((item) => item.id === peer.id);
    if (!next) io.to(snapshot.id).except(peer.id).emit('peer:left', { peerId: peer.id });
    for (const share of peer.shares) {
      if (!next?.shares.some((item) => item.id === share.id))
        io.to(snapshot.id).except(peer.id).emit('producer:closed', { producerId: share.id, peerId: peer.id });
    }
  }
  for (const peer of snapshot.peers) {
    const old = previous?.peers.find((item) => item.id === peer.id);
    if (!old) io.to(snapshot.id).except(peer.id).emit('peer:joined', peer);
    for (const share of peer.shares) {
      if (!old?.shares.some((item) => item.id === share.id))
        io.to(snapshot.id)
          .except(peer.id)
          .emit('producer:new', {
            producerId: share.id,
            peerId: peer.id,
            peerName: peer.name,
            ...share,
          });
    }
  }
  federation.reconcile(snapshot.id, new Set(snapshot.peers.flatMap((peer) => peer.shares.map((share) => share.id))));
  if (!snapshot.peers.some((peer) => peer.siteId === config.site.id)) roomSnapshots.delete(snapshot.id);
};
app.get('/health', (_req, res) =>
  res
    .status(cluster.ready ? 200 : 503)
    .json({ status: cluster.ready ? 'ok' : 'waiting-for-master', siteId: config.site.id, rooms: rooms.size }),
);
app.use('/sfu', (_req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  next();
});
app.get('/sfu/ping', (_req, res) => res.status(cluster.ready ? 200 : 503).json({ siteId: config.site.id }));
app.get('/sfu/sites', async (_req, res) => {
  try {
    res.json(await cluster.request({ action: 'sites' }));
  } catch {
    res.status(503).json({ error: 'ルーム管理サーバーに接続できません' });
  }
});
app.get('/internal/rooms', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await cluster.request({ action: 'rooms' }));
  } catch {
    res.status(503).json({ error: 'Master unavailable' });
  }
});
app.get('/internal/cluster', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ siteId: config.site.id, ready: cluster.ready, ...(await federation.diagnostics()) });
});
const workers: mediasoup.types.Worker[] = [];
const clientTransports = new Set<mediasoup.types.WebRtcTransport>();
cluster.onStatistics = createStatisticsCollector(config.role, rooms, workers, clientTransports, federation);
app.get('/sfu/statistics', async (_req, res) => {
  try {
    res.json(await cluster.request({ action: 'statistics' }));
  } catch {
    res.status(503).json({ error: 'クラスタの統計を取得できません。マスターへの接続を確認してください。' });
  }
});
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
const shareWorkers = new ShareWorkerPool(workers, mediaCodecs);

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
  const room = rooms.get(roomId);
  if (room) {
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
    room.emptySince = null;
    return room;
  }
  const pending = pendingRooms.get(roomId);
  if (pending) return pending;
  const creating = (async () => {
    const router = await pickWorker().createRouter({ mediaCodecs });
    const created: Room = {
      id: roomId,
      name: roomName || '配信ルーム',
      router,
      routing: new ShareRouting(shareWorkers),
      peers: new Map(),
      compatibilityRequests: new Map(),
      compatibilityStreams: new Map(),
      cleanupTimer: null,
      emptySince: null,
    };
    rooms.set(roomId, created);
    retainEmptyRoom(created);
    return created;
  })().finally(() => pendingRooms.delete(roomId));
  pendingRooms.set(roomId, creating);
  return creating;
}

function retainEmptyRoom(room: Room) {
  if (room.peers.size) return;
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.emptySince = Date.now();
  room.cleanupTimer = setTimeout(() => {
    if (room.peers.size || rooms.get(room.id) !== room) return;
    room.router.close();
    room.routing.close();
    rooms.delete(room.id);
    roomSnapshots.delete(room.id);
  }, ROOM_RETENTION_MS);
  room.cleanupTimer.unref();
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
  const router = room.routing.producerRouter(producerId) || room.router;
  if (router.canConsume({ producerId, rtpCapabilities })) return original;
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
  if (!router.canConsume({ producerId: compatible.id, rtpCapabilities }))
    throw new Error('この端末は互換配信に対応していません');
  return compatible;
}

io.on('connection', (socket) => {
  socket.on('connection:ping', (reply) => {
    if (typeof reply === 'function') reply({ ready: cluster.ready });
  });
  let room: Room | undefined;
  let peer: Peer | undefined;
  let joining = false;
  const transports = new Map<string, mediasoup.types.WebRtcTransport>();
  const producers = new Map<string, Producer>();
  const consumers = new Map<string, mediasoup.types.Consumer>();
  const keyFrameRequests = new Map<string, number>();
  const consumerSetupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const acknowledgeConsumer = (id: string) => {
    clearTimeout(consumerSetupTimers.get(id));
    consumerSetupTimers.delete(id);
  };
  const reply = (callback: unknown, value: Record<string, unknown>) => {
    if (typeof callback === 'function') callback(value);
  };

  socket.on('room:create', async ({ name }, callback) => {
    const creatorName = String(name || 'ゲスト').slice(0, 40);
    try {
      const joinedRoom = await joinRoom(undefined, creatorName);
      reply(callback, {
        ok: true,
        roomId: joinedRoom.id,
        roomName: joinedRoom.name,
        voiceChatEnabled: cluster.rooms.get(joinedRoom.id)?.voiceChatEnabled === true,
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
        voiceChatEnabled: cluster.rooms.get(joinedRoom.id)?.voiceChatEnabled === true,
        rtpCapabilities: joinedRoom.router.rtpCapabilities,
        peers: (cluster.rooms.get(id)?.peers || []).filter((p) => p.id !== socket.id),
      });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('room:sync', (callback) => {
    if (!room || !peer) return reply(callback, { ok: false, error: 'Not joined to a room' });
    reply(callback, {
      ok: true,
      voiceChatEnabled: cluster.rooms.get(room.id)?.voiceChatEnabled === true,
      peers: (cluster.rooms.get(room.id)?.peers || []).filter((item) => item.id !== socket.id),
    });
  });

  socket.on('room:voice', async ({ enabled }, callback) => {
    try {
      if (!room || !peer) throw new Error('先にルームに参加してください');
      const result = await cluster.request<{ voiceChatEnabled: boolean }>({
        action: 'voice',
        roomId: room.id,
        peerId: socket.id,
        enabled,
      });
      reply(callback, { ok: true, ...result });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  async function joinRoom(id: string | undefined, name: string) {
    if (room || joining) throw new Error('すでにルームに参加しています');
    joining = true;
    let snapshot: RoomSnapshot | undefined;
    try {
      snapshot = await cluster.request<RoomSnapshot>({
        action: 'join',
        roomId: id,
        peerId: socket.id,
        name: String(name).slice(0, 40),
      });
      if (!socket.connected) throw new Error('Participant disconnected');
      const joined = await getRoom(snapshot.id, snapshot.name);
      if (!socket.connected) throw new Error('Participant disconnected');
      room = joined;
      peer = { id: socket.id, name: String(name).slice(0, 40), producers };
      room.peers.set(socket.id, peer);
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
      room.emptySince = null;
      socket.join(room.id);
      return room;
    } catch (error) {
      if (snapshot) void cluster.request({ action: 'leave', roomId: snapshot.id, peerId: socket.id }).catch(() => {});
      throw error;
    } finally {
      joining = false;
    }
  }

  socket.on('transport:create', async ({ direction, producerId, newShare }, callback) => {
    try {
      if (!room) throw new Error('先にルームに参加してください');
      if (direction !== 'send' && direction !== 'recv') throw new Error('Invalid transport direction');
      let target: mediasoup.types.Router | string | undefined = room.router;
      if (producerId) {
        const local = [...room.peers.values()].find((item) => item.producers.has(producerId));
        if (direction === 'send' && local?.id !== socket.id) throw new Error('Invalid share owner');
        if (local) target = room.routing.producerRouter(producerId) || room.router;
        else {
          const remote = cluster.rooms
            .get(room.id)
            ?.peers.flatMap((item) => item.shares)
            .find((item) => item.id === producerId);
          if (!remote) throw new Error('共有が終了しています');
          target = `remote:${remote.appData.videoProducerId || producerId}`;
        }
      } else if (direction === 'send' && newShare) target = undefined;
      const transport = await room.routing.createTransport(target, createWebRtcTransport);
      transport.appData.direction = direction;
      transport.appData.producerId = producerId;
      if (!socket.connected) {
        transport.close();
        throw new Error('Participant disconnected');
      }
      transports.set(transport.id, transport);
      clientTransports.add(transport);
      transport.observer.once('close', () => clientTransports.delete(transport));
      console.info(
        `[webrtc] transport=${transport.id} direction=${direction} candidates=${JSON.stringify(transport.iceCandidates.map(({ protocol, address, port }) => ({ protocol, address, port })))}`,
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
      if (transport.appData.direction !== 'send') throw new Error('Invalid transport direction');
      const producerRoom = room;
      if (appData?.voiceChat) {
        if (!cluster.rooms.get(room.id)?.voiceChatEnabled) throw new Error('ルームのVCは無効です');
        if (kind !== 'audio' || appData.videoProducerId || appData.compatibilityFor)
          throw new Error('VC must be an independent audio stream');
        if ([...producers.values()].some((producer) => producer.appData.voiceChat))
          throw new Error('VC stream already exists');
      }
      const parent = appData?.compatibilityFor ? producers.get(appData.compatibilityFor) : undefined;
      if (
        appData?.compatibilityFor &&
        (!parent || parent.closed || parent.kind !== 'video' || parent.appData.compatibilityFor || kind !== 'video')
      )
        throw new Error('Invalid compatibility source');
      if (parent && room.compatibilityStreams.has(parent.id)) throw new Error('Compatibility stream already exists');
      const router = room.routing.transportRouter(transportId)!;
      const relatedId = appData?.compatibilityFor || appData?.videoProducerId;
      const related = relatedId ? producers.get(relatedId) : undefined;
      if (
        relatedId &&
        (!related ||
          related.closed ||
          related.kind !== 'video' ||
          (room.routing.producerRouter(relatedId) || room.router) !== router)
      )
        throw new Error('Related media must use the screen router');
      const producer = await transport.produce<ShareAppData>({
        kind,
        rtpParameters,
        appData: { ...appData, ownerId: socket.id },
      });
      if (related?.closed || !socket.connected || transport.closed) {
        producer.close();
        throw new Error('共有が終了しています');
      }
      producers.set(producer.id, producer);
      room.routing.registerProducer(producer, router);
      if (related) {
        const closeRelated = () => producer.close();
        related.observer.once('close', closeRelated);
        producer.observer.once('close', () => related.observer.removeListener('close', closeRelated));
      }
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
          void cluster
            .request({ action: 'unpublish', roomId: producerRoom.id, peerId: socket.id, producerId: producer.id })
            .catch(() => {});
        }
      });
      if (!parent) {
        try {
          await cluster.request({
            action: 'publish',
            roomId: producerRoom.id,
            peerId: socket.id,
            share: {
              id: producer.id,
              kind,
              profile: appData?.profile,
              label: appData?.label || '画面共有',
              appData: producer.appData,
            },
          });
          if (producer.closed) {
            await cluster.request({
              action: 'unpublish',
              roomId: producerRoom.id,
              peerId: socket.id,
              producerId: producer.id,
            });
            throw new Error('共有が終了しています');
          }
        } catch (error) {
          producer.close();
          throw error;
        }
      }
      reply(callback, { ok: true, id: producer.id });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    let lease: ProducerLease | undefined;
    let consumer: mediasoup.types.Consumer | undefined;
    try {
      const transport = transports.get(transportId);
      if (!transport || !room) throw new Error('Transport not found');
      if (transport.appData.direction !== 'recv') throw new Error('Invalid transport direction');
      const router = room.routing.transportRouter(transportId)!;
      const local = [...room.peers.values()].some((peer) => peer.producers.has(producerId));
      if (transport.appData.producerId && transport.appData.producerId !== producerId)
        throw new Error('Invalid receive source');
      if (!local) lease = await federation.acquire(room, producerId, rtpCapabilities, router);
      const source = lease?.producer || (await consumableProducer(room, producerId, rtpCapabilities));
      if (local && (room.routing.producerRouter(source.id) || room.router) !== router)
        throw new Error('Create a receive transport for this screen');
      consumer = await transport.consume({ producerId: source.id, rtpCapabilities, paused: true });
      const consumed = consumer;
      if (!socket.connected || transport.closed) throw new Error('Participant disconnected');
      lease?.attach(consumer);
      consumers.set(consumer.id, consumer);
      const setupTimer = setTimeout(() => {
        consumers.delete(consumed.id);
        consumed.close();
      }, 30000);
      setupTimer.unref();
      consumerSetupTimers.set(consumer.id, setupTimer);
      consumer.observer.once('close', () => {
        acknowledgeConsumer(consumed.id);
        keyFrameRequests.delete(consumed.id);
      });
      const compatibility = source.appData.compatibilityFor
        ? room.compatibilityStreams.get(source.appData.compatibilityFor)
        : undefined;
      if (compatibility) {
        if (compatibility.timer) clearTimeout(compatibility.timer);
        compatibility.consumers.add(consumer.id);
        consumer.observer.once('close', () => {
          compatibility.consumers.delete(consumed.id);
          if (!source.closed) compatibility.scheduleClose();
        });
      }
      consumer.on('transportclose', () => consumers.delete(consumed.id));
      consumer.on('producerclose', () => {
        consumers.delete(consumed.id);
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
      consumer?.close();
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      lease?.release();
    }
  });

  socket.on('consumer:resume', async ({ consumerId }, callback) => {
    try {
      const consumer = consumers.get(consumerId);
      if (!consumer) throw new Error('Consumer not found');
      acknowledgeConsumer(consumerId);
      await consumer.resume();
      await federation.synchronizeConsumer(consumer);
      if (consumer.kind === 'video') await consumer.requestKeyFrame();
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('consumer:keyframe', async ({ consumerId }, callback) => {
    try {
      const consumer = consumers.get(consumerId);
      if (!consumer || consumer.kind !== 'video') throw new Error('Video consumer not found');
      if (!consumer.paused && Date.now() - (keyFrameRequests.get(consumerId) || 0) >= 1000) {
        keyFrameRequests.set(consumerId, Date.now());
        await federation.synchronizeConsumer(consumer);
        await consumer.requestKeyFrame();
      }
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('consumer:pause', async ({ consumerId }, callback) => {
    try {
      const consumer = consumers.get(consumerId);
      if (!consumer) throw new Error('Consumer not found');
      acknowledgeConsumer(consumerId);
      await consumer.pause();
      await federation.synchronizeConsumer(consumer);
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
    room.peers.delete(socket.id);
    void cluster.request({ action: 'leave', roomId: room.id, peerId: socket.id }).catch(() => {});
    retainEmptyRoom(room);
  });
});

const workerCount = Math.max(1, Number(process.env.MEDIASOUP_WORKERS || 1));
for (let i = 0; i < workerCount; i++) workers.push(await createWorker());
installSfuProbe(io, workers[0], config.site.id, () => cluster.ready);
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Eigetsu signaling/SFU site=${config.site.id} role=${config.role} listening on :${config.port}`);
  cluster.connect();
});
