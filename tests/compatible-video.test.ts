import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { types as Media } from 'mediasoup-client';
import { createCompatibleVideoSender } from '../src/compatible-video.ts';
import type { CreateSendTransport, Producer, ShareAppData, Transport } from '../src/types.ts';

const baseline: Media.RtpCodecCapability = {
  kind: 'video',
  mimeType: 'video/H264',
  clockRate: 90_000,
  preferredPayloadType: 102,
  parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f' },
};

interface TestSource {
  id: string;
  closed: boolean;
  appData: ShareAppData;
  observer: EventEmitter;
  track: {
    readyState: string;
    clone: () => { readyState: string; getSettings: () => { width: number; height: number }; stop(): void };
  };
}

interface TestProducer {
  id: string;
  closed: boolean;
  close(): void;
}

function fixture(createTransport: CreateSendTransport) {
  const clone = {
    readyState: 'live',
    getSettings: () => ({ width: 3840, height: 2160 }),
    stop() {
      this.readyState = 'ended';
    },
  };
  const source: TestSource = {
    id: 'main',
    closed: false,
    appData: { label: 'Screen', compatibilitySupported: true },
    observer: new EventEmitter(),
    track: { readyState: 'live', clone: () => clone },
  };
  const manager = createCompatibleVideoSender({
    getProducer: () => source as unknown as Producer,
    createTransport,
    capabilities: { codecs: [baseline] },
  });
  const request = () =>
    new Promise<{ ok: true; producerId: string } | { ok: false; error: string }>((resolve) =>
      manager.request({ producerId: 'main' }, resolve),
    );
  return { clone, source, manager, request };
}

function mockTransport(
  produce: (options: Media.ProducerOptions<ShareAppData>) => Promise<Producer>,
  close: () => void = () => {},
): Transport {
  return { produce, close } as unknown as Transport;
}

test('concurrent compatibility requests share a bounded encoder and preserve the capture', async () => {
  let options: Media.ProducerOptions<ShareAppData> | undefined;
  let created = 0,
    transportClosed = false;
  const child: TestProducer = {
    id: 'compatible',
    closed: false,
    close() {
      this.closed = true;
    },
  };
  const { request, manager, clone, source } = fixture(async () => {
    created++;
    return mockTransport(
      async (value) => {
        options = value;
        return child as unknown as Producer;
      },
      () => {
        transportClosed = true;
      },
    );
  });
  const results = await Promise.all([request(), request()]);
  assert.deepEqual(results, [
    { ok: true, producerId: 'compatible' },
    { ok: true, producerId: 'compatible' },
  ]);
  assert.equal(created, 1);
  assert.ok(options);
  assert.equal(options.codec, baseline);
  assert.equal(options.encodings?.[0]?.scaleResolutionDownBy, 2);
  assert.equal(options.encodings?.[0]?.maxFramerate, 60);
  assert.equal(options.encodings?.[0]?.maxBitrate, 9_000_000);
  assert.equal(options.appData?.compatibilityFor, 'main');
  assert.equal(options.appData?.compatibilitySupported, false);
  manager.stop('main');
  assert.equal(clone.readyState, 'ended');
  assert.equal(source.track.readyState, 'live');
  assert.ok(transportClosed && child.closed);
  assert.equal(source.observer.listenerCount('close'), 0);
});

test('ending the source while a compatibility transport is pending releases the late transport', async () => {
  let resolveTransport: ((transport: Transport) => void) | undefined;
  let transportClosed = false,
    produced = false;
  const { request, clone, source } = fixture(
    () =>
      new Promise((resolve) => {
        resolveTransport = resolve;
      }),
  );
  const pending = request();
  source.closed = true;
  source.observer.emit('close');
  assert.ok(resolveTransport);
  resolveTransport(
    mockTransport(
      async () => {
        produced = true;
        throw new Error('unexpected produce');
      },
      () => {
        transportClosed = true;
      },
    ),
  );
  assert.equal((await pending).ok, false);
  assert.equal(produced, false);
  assert.equal(transportClosed, true);
  assert.equal(clone.readyState, 'ended');
});

test('failed compatibility negotiation releases its cloned track and transport', async () => {
  let closed = false;
  const { request, clone, source, manager } = fixture(async () =>
    mockTransport(
      async () => {
        throw new Error('negotiation failed');
      },
      () => {
        closed = true;
      },
    ),
  );
  assert.deepEqual(await request(), { ok: false, error: 'negotiation failed' });
  assert.equal(clone.readyState, 'ended');
  assert.equal(source.track.readyState, 'live');
  assert.equal(closed, true);
  assert.equal(source.observer.listenerCount('close'), 0);
  manager.close();
});
