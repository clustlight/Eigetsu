import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { types as Media } from '../sfu/node_modules/mediasoup/node/lib/index.d.ts';
import { Federation } from '../sfu/federation.ts';
import type { ClusterClient } from '../sfu/cluster-client.ts';
import type { PipeCommand, RoomSnapshot, Site } from '../sfu/cluster-types.ts';
import type { Producer, Room } from '../sfu/types.ts';

const require = createRequire(new URL('../sfu/package.json', import.meta.url));
const mediasoup = require('mediasoup');

test(
  'an expired inter-site pipe can recover on the same SFUs without changing the logical producer',
  { timeout: 10000 },
  async (t) => {
    const workers: Media.Worker[] = [];
    t.after(() => workers.forEach((worker) => worker.close()));
    for (const rtcMinPort of [44000, 44200])
      workers.push(await mediasoup.createWorker({ rtcMinPort, rtcMaxPort: rtcMinPort + 100 }));
    const codecs = [{ kind: 'audio' as const, mimeType: 'audio/opus', clockRate: 48000, channels: 2 }];
    const [originRouter, targetRouter] = await Promise.all(
      workers.map((worker) => worker.createRouter({ mediaCodecs: codecs })),
    );
    const input = await originRouter.createDirectTransport();
    const source = await input.produce({
      kind: 'audio',
      rtpParameters: {
        codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
        encodings: [{ ssrc: 123456 }],
        rtcp: { cname: 'pipe-recovery-test' },
      },
    });
    const localRoom = (router: Media.Router, id: string, producers: Map<string, Producer>): Room => ({
      id: 'ROOM01',
      name: 'Pipe recovery',
      router,
      peers: new Map([[id, { id, name: id, producers }]]),
      compatibilityStreams: new Map(),
      compatibilityRequests: new Map(),
      cleanupTimer: null,
      emptySince: null,
    });
    const originRoom = localRoom(originRouter, 'sender', new Map([[source.id, source]]));
    const targetRoom = localRoom(targetRouter, 'viewer', new Map());
    const snapshot: RoomSnapshot = {
      id: 'ROOM01',
      name: 'Pipe recovery',
      emptySince: null,
      peers: [
        {
          id: 'sender',
          name: 'sender',
          siteId: 'a',
          shares: [{ id: source.id, kind: 'audio', label: 'audio', appData: {} }],
        },
        { id: 'viewer', name: 'viewer', siteId: 'b', shares: [] },
      ],
    };
    const controls = new Map<string, { onOperation: (from: Site, command: PipeCommand) => Promise<unknown> }>();
    const control = (id: string) => {
      const value = {
        site: { id, url: '', pipeAddress: '127.0.0.1', instanceId: id } satisfies Site,
        rooms: new Map<string, RoomSnapshot>([['ROOM01', snapshot]]),
        ready: true,
        onOperation: async () => {
          throw new Error('Operation handler has not been attached');
        },
        async relay(target: string, command: PipeCommand) {
          const remote = controls.get(target);
          if (!remote) throw new Error(`Unknown site: ${target}`);
          return remote.onOperation(value.site, command);
        },
      };
      controls.set(id, value);
      return value as unknown as ClusterClient;
    };
    const a = control('a'),
      b = control('b');
    const origin = new Federation({
      cluster: a,
      rooms: new Map([['ROOM01', originRoom]]),
      listenIp: '127.0.0.1',
      resolveLocal: async () => source,
    });
    const destination = new Federation({
      cluster: b,
      rooms: new Map([['ROOM01', targetRoom]]),
      listenIp: '127.0.0.1',
      resolveLocal: async () => {
        throw new Error('Not local');
      },
    });
    let originPipe: Media.PipeTransport | undefined;
    originRouter.observer.on('newtransport', (transport) => {
      originPipe = transport as Media.PipeTransport;
    });
    const receiver = await targetRouter.createWebRtcTransport({ listenInfos: [{ protocol: 'udp', ip: '127.0.0.1' }] });
    const subscribe = async () => {
      const lease = await destination.acquire(targetRoom, source.id, targetRouter.rtpCapabilities);
      const consumer = await receiver.consume({
        producerId: lease.producer.id,
        rtpCapabilities: targetRouter.rtpCapabilities,
      });
      lease.attach(consumer);
      await destination.synchronizeConsumer(consumer);
      return consumer;
    };
    const first = await subscribe();
    const retry = new Promise((resolve) => {
      destination.onRetry = (roomId, producerId) => resolve({ roomId, producerId });
    });
    assert.ok(originPipe);
    originPipe.close();
    assert.deepEqual(await retry, { roomId: 'ROOM01', producerId: source.id });
    assert.ok(first.closed, 'The failed local consumer must be released before retry');
    const second = await subscribe();
    assert.equal(second.producerId, source.id);
    assert.equal((await origin.diagnostics()).outgoing.length, 1);
    assert.equal((await destination.diagnostics()).incoming.length, 1);
    second.close();
    assert.equal((await destination.diagnostics()).incoming.length, 0);
  },
);
