import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { types as Media } from '../sfu/node_modules/mediasoup/node/lib/index.d.ts';
import { ShareRouting, ShareWorkerPool } from '../sfu/share-routing.ts';

const require = createRequire(new URL('../sfu/package.json', import.meta.url));
const mediasoup = require('mediasoup');
const codecs: Media.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
];

test('concurrent screens balance across workers; audio, compatibility and viewers keep screen affinity', async (t) => {
  const workers: Media.Worker[] = [];
  t.after(() => workers.forEach((worker) => worker.close()));
  for (let i = 0; i < 2; i++) workers.push(await mediasoup.createWorker());
  const pool = new ShareWorkerPool(workers, codecs);
  const routing = new ShareRouting(pool);
  const otherRoom = new ShareRouting(pool);
  const direct = (router: Media.Router) => router.createDirectTransport();
  const screens = await Promise.all(Array.from({ length: 4 }, () => routing.createTransport(undefined, direct)));
  const routers = screens.map((transport) => routing.transportRouter(transport.id)!);
  assert.equal(new Set(routers.map((router) => router.id)).size, 4);
  assert.deepEqual(
    routers.map((router) => router.appData.workerPid),
    [workers[0].pid, workers[1].pid, workers[0].pid, workers[1].pid],
  );
  for (const [index, worker] of workers.entries()) {
    const dump = await worker.dump();
    assert.deepEqual(new Set(dump.routerIds), new Set([routers[index].id, routers[index + 2].id]));
  }
  const source = await screens[0].produce({
    kind: 'video',
    rtpParameters: {
      codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }],
      encodings: [{ ssrc: 1234 }],
    },
  });
  routing.registerProducer(source, routers[0]);
  const siblings = await Promise.all(
    Array.from({ length: 3 }, () => routing.createTransport(routing.producerRouter(source.id), direct)),
  );
  assert.ok(siblings.every((transport) => routing.transportRouter(transport.id) === routers[0]));
  const audio = await siblings[0].produce({
    kind: 'audio',
    rtpParameters: {
      codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
      encodings: [{ ssrc: 5678 }],
    },
  });
  const consumer = await siblings[2].consume({ producerId: audio.id, rtpCapabilities: routers[0].rtpCapabilities });
  assert.equal(consumer.producerId, audio.id);
  screens[0].close();
  assert.equal(routing.producerRouter(source.id), undefined);
  assert.equal(routers[0].closed, false, 'Sibling transports still hold the router');
  siblings.forEach((transport) => transport.close());
  assert.equal(routers[0].closed, true);
  const replacement = await otherRoom.createTransport(undefined, direct);
  assert.equal(
    otherRoom.transportRouter(replacement.id)!.appData.workerPid,
    workers[0].pid,
    'Released capacity is reused across rooms',
  );
  routing.close();
  otherRoom.close();
  await Promise.resolve();
  assert.ok(routers.every((router) => router.closed));
});

test('remote viewers coalesce by screen, release idle routers, and recover from failed setup', async (t) => {
  const worker: Media.Worker = await mediasoup.createWorker();
  t.after(() => worker.close());
  const routing = new ShareRouting(new ShareWorkerPool([worker], codecs));
  const routers: Media.Router[] = [];
  worker.observer.on('newrouter', (router) => routers.push(router));
  const direct = (router: Media.Router) => router.createDirectTransport();
  const viewers = await Promise.all(Array.from({ length: 3 }, () => routing.createTransport('remote:screen', direct)));
  assert.equal(routers.length, 1);
  const other = await routing.createTransport('remote:other', direct);
  assert.equal(routers.length, 2);
  viewers.forEach((transport) => transport.close());
  assert.equal(routers[0].closed, true);
  assert.equal(routers[1].closed, false);
  await assert.rejects(
    routing.createTransport('failed', async () => {
      throw new Error('setup failed');
    }),
    /setup failed/,
  );
  assert.equal(routers[2].closed, true);
  const retry = await routing.createTransport('failed', direct);
  assert.equal(routers[3].closed, false);
  retry.close();
  other.close();
  assert.ok(routers.every((router) => router.closed));
});

test('closing a room during router creation releases the pending allocation', async (t) => {
  const worker: Media.Worker = await mediasoup.createWorker();
  t.after(() => worker.close());
  const routing = new ShareRouting(new ShareWorkerPool([worker], codecs));
  const pending = routing.createTransport(undefined, (router) => router.createDirectTransport());
  routing.close();
  await assert.rejects(pending, /Room closed/);
  assert.deepEqual((await worker.dump()).routerIds, []);
});
