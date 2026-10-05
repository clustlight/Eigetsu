import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configureScreenShareReceiver,
  readScreenConnectionStats,
  readScreenReceiveStats,
  readVideoPlaybackStats,
} from '../src/screen-share-receive.ts';
import type { MediaStatsSample, PlaybackSample } from '../src/media-stats.ts';
import type { ScreenStats } from '../src/media-stats.ts';

const codec: MediaStatsSample = { id: 'codec', timestamp: 0, type: 'codec', mimeType: 'video/H264' };
const inbound = {
  id: 'video',
  type: 'inbound-rtp',
  kind: 'video',
  codecId: codec.id,
  timestamp: 1000,
  bytesReceived: 1000,
  framesReceived: 100,
  framesDecoded: 90,
  totalDecodeTime: 1,
  framesDropped: 10,
  packetsReceived: 900,
  packetsLost: 10,
  jitterBufferDelay: 9,
  jitterBufferEmittedCount: 90,
  freezeCount: 3,
};
const report = (...stats: Array<Omit<MediaStatsSample, 'timestamp'> & { timestamp?: number }>) =>
  new Map<string, MediaStatsSample>(
    [codec, ...stats.map((stat) => ({ timestamp: 0, ...stat }))].map((stat) => [stat.id, stat]),
  );
const readStats = (samples: ReturnType<typeof report>, previous?: MediaStatsSample) => {
  const stats = readScreenReceiveStats(samples, previous);
  assert.ok(stats);
  return stats;
};
const configureReceiver = (receiver: unknown) =>
  configureScreenShareReceiver({ rtpReceiver: receiver } as Parameters<typeof configureScreenShareReceiver>[0]);

test('distinguishes incoming frame rate, decoding, packet loss and interval buffer delay', () => {
  const next = {
    ...inbound,
    timestamp: 3000,
    bytesReceived: 6_001_000,
    framesReceived: 220,
    framesDecoded: 190,
    totalDecodeTime: 1.5,
    framesDropped: 30,
    packetsReceived: 1098,
    packetsLost: 12,
    jitterBufferDelay: 21,
    jitterBufferEmittedCount: 190,
    freezeCount: 4,
  };
  const stats = readStats(
    report({ ...next, id: 'probe', codecId: undefined }, { ...next, id: 'audio', kind: 'audio' }, next),
    inbound,
  );
  assert.equal(stats.sample.id, 'video');
  assert.equal(stats.codec, 'video/H264');
  assert.equal(stats.bitrateMbps, 24);
  assert.equal(stats.receivedFps, 60);
  assert.equal(stats.fps, 50);
  assert.equal(stats.decodeMs, 5);
  assert.equal(stats.dropped, 20);
  assert.equal(stats.lossPercent, 1);
  assert.equal(stats.bufferMs, 120);
  assert.equal(stats.freezes, 1);
});

test('first sample, stream changes and reset counters remain unknown rather than bogus', () => {
  const cases: Array<[MediaStatsSample, MediaStatsSample | undefined]> = [
    [inbound, undefined],
    [inbound, inbound],
    [{ ...inbound, id: 'other', timestamp: 3000 }, inbound],
    [
      {
        ...inbound,
        timestamp: 3000,
        bytesReceived: 0,
        framesDecoded: 0,
        framesReceived: 0,
        totalDecodeTime: 0,
        packetsLost: 0,
        jitterBufferDelay: 0,
        jitterBufferEmittedCount: 0,
      },
      inbound,
    ],
  ];
  for (const [sample, previous] of cases) {
    const stats = readScreenReceiveStats(report(sample), previous);
    assert.ok(stats);
    const fields: Array<
      keyof Pick<ScreenStats, 'bitrateMbps' | 'fps' | 'receivedFps' | 'decodeMs' | 'lossPercent' | 'bufferMs'>
    > = ['bitrateMbps', 'fps', 'receivedFps', 'decodeMs', 'lossPercent', 'bufferMs'];
    for (const field of fields) {
      assert.equal(stats[field], null, field);
    }
  }
  assert.equal(readScreenReceiveStats(report()), null);
  const sparse = readStats(
    report({
      ...inbound,
      timestamp: 3000,
      totalDecodeTime: undefined,
      framesDecoded: 150,
      jitterBufferDelay: undefined,
    }),
    inbound,
  );
  assert.equal(sparse.fps, 30);
  assert.equal(sparse.decodeMs, null);
  assert.equal(sparse.bufferMs, null);
  assert.equal(readStats(report({ ...inbound, timestamp: 3000 }), inbound).fps, 0);
});

test('playback FPS excludes presentation drops and resets on element replacement', () => {
  const element = {} as HTMLVideoElement;
  const previous: PlaybackSample = { id: element, timestamp: 1000, total: 100, dropped: 10 };
  const sample = { ...previous, timestamp: 3000, total: 220, dropped: 30 };
  assert.equal(readVideoPlaybackStats(sample, previous).fps, 50);
  assert.equal(readVideoPlaybackStats(sample, previous).dropped, 20);
  assert.equal(readVideoPlaybackStats({ ...sample, id: {} as HTMLVideoElement }, previous).fps, null);
  assert.equal(readVideoPlaybackStats({ ...sample, total: 0 }, previous).fps, null);
  assert.equal(readVideoPlaybackStats(sample).fps, null);
});

test('both media kinds get the same buffer and unsupported receivers remain usable', (t) => {
  for (const kind of ['audio', 'video']) {
    const rtpReceiver = { track: { kind }, jitterBufferTarget: null };
    assert.equal(configureReceiver(rtpReceiver), true);
    assert.equal(rtpReceiver.jitterBufferTarget, 100);
  }
  const unsupported = {};
  assert.equal(configureReceiver(unsupported), false);
  assert.equal('jitterBufferTarget' in unsupported, false);
  t.mock.method(console, 'warn', () => {});
  assert.equal(
    configureReceiver({
      get jitterBufferTarget() {
        return null;
      },
      set jitterBufferTarget(_) {
        throw new Error('unsupported');
      },
    }),
    false,
  );
});

test('connection diagnostics use the selected candidate pair, not another nominated pair', () => {
  const stats = report(
    { id: 'unused', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.001 },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' },
    {
      id: 'selected',
      type: 'candidate-pair',
      currentRoundTripTime: 0.2,
      availableOutgoingBitrate: 12_000_000,
      remoteCandidateId: 'remote',
    },
    { id: 'remote', type: 'remote-candidate', protocol: 'tcp' },
  );
  assert.deepEqual(readScreenConnectionStats(stats, { id: 'media', timestamp: 0, transportId: 'transport' }), {
    protocol: 'tcp',
    rttMs: 200,
    availableOutgoingMbps: 12,
  });
  const noConnection = { id: 'media', timestamp: 0 };
  assert.equal(readScreenConnectionStats(report(), noConnection).rttMs, null);
  assert.equal(readScreenConnectionStats(report(), noConnection).protocol, undefined);
});
