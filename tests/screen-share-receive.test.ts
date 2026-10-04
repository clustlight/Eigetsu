import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configureScreenShareReceiver,
  readScreenConnectionStats,
  readScreenReceiveStats,
  readVideoPlaybackStats,
} from '../src/screen-share-receive.ts';

const codec = { id: 'codec', type: 'codec', mimeType: 'video/H264' };
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
const report = (...stats) => new Map([codec, ...stats].map((stat) => [stat.id, stat]));

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
  const stats = readScreenReceiveStats(
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
  for (const [sample, previous] of [
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
  ]) {
    const stats = readScreenReceiveStats(report(sample), previous);
    for (const field of ['bitrateMbps', 'fps', 'receivedFps', 'decodeMs', 'lossPercent', 'bufferMs']) {
      assert.equal(stats[field], null, field);
    }
  }
  assert.equal(readScreenReceiveStats(report()), null);
  const sparse = readScreenReceiveStats(
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
  assert.equal(readScreenReceiveStats(report({ ...inbound, timestamp: 3000 }), inbound).fps, 0);
});

test('playback FPS excludes presentation drops and resets on element replacement', () => {
  const previous = { id: 'element', timestamp: 1000, total: 100, dropped: 10 };
  const sample = { ...previous, timestamp: 3000, total: 220, dropped: 30 };
  assert.equal(readVideoPlaybackStats(sample, previous).fps, 50);
  assert.equal(readVideoPlaybackStats(sample, previous).dropped, 20);
  assert.equal(readVideoPlaybackStats({ ...sample, id: 'new' }, previous).fps, null);
  assert.equal(readVideoPlaybackStats({ ...sample, total: 0 }, previous).fps, null);
  assert.equal(readVideoPlaybackStats(sample).fps, null);
});

test('both media kinds get the same buffer and unsupported receivers remain usable', (t) => {
  for (const kind of ['audio', 'video']) {
    const rtpReceiver = { track: { kind }, jitterBufferTarget: null };
    assert.equal(configureScreenShareReceiver({ rtpReceiver }), true);
    assert.equal(rtpReceiver.jitterBufferTarget, 100);
  }
  const unsupported = {};
  assert.equal(configureScreenShareReceiver({ rtpReceiver: unsupported }), false);
  assert.equal('jitterBufferTarget' in unsupported, false);
  t.mock.method(console, 'warn', () => {});
  assert.equal(
    configureScreenShareReceiver({
      rtpReceiver: {
        get jitterBufferTarget() {
          return null;
        },
        set jitterBufferTarget(_) {
          throw new Error('unsupported');
        },
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
  assert.deepEqual(readScreenConnectionStats(stats, { transportId: 'transport' }), {
    protocol: 'tcp',
    rttMs: 200,
    availableOutgoingMbps: 12,
  });
  assert.equal(readScreenConnectionStats(report(), {}).rttMs, null);
  assert.equal(readScreenConnectionStats(report(), {}).protocol, undefined);
});
