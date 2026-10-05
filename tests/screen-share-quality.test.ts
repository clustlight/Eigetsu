import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  preferScreenShareResolution,
  produceScreenShareVideo,
  readScreenShareStats,
  screenShareEncodingOptions,
  selectScreenShareCodec,
} from '../src/screen-share-quality.ts';
import { qualityPresets } from '../src/quality-presets.ts';
import type { MediaStatsSample } from '../src/media-stats.ts';
import type { types as Media } from 'mediasoup-client';
import type { Transport } from '../src/types.ts';

const video = {
  id: 'video',
  type: 'outbound-rtp',
  kind: 'video',
  codecId: 'vp8',
  timestamp: 1000,
  bytesSent: 1000,
  framesEncoded: 30,
};
const report = (...stats: Array<Omit<MediaStatsSample, 'timestamp'> & { timestamp?: number }>) =>
  new Map<string, MediaStatsSample>(stats.map((stat) => [stat.id, { timestamp: 0, ...stat }]));
const readStats = (samples: ReturnType<typeof report>, previous?: MediaStatsSample) => {
  const stats = readScreenShareStats(samples, previous);
  assert.ok(stats);
  return stats;
};
const h264: Media.RtpCodecCapability = {
  kind: 'video',
  mimeType: 'video/H264',
  clockRate: 90000,
  preferredPayloadType: 102,
  parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f' },
};
const vp8: Media.RtpCodecCapability = {
  kind: 'video',
  mimeType: 'video/VP8',
  clockRate: 90000,
  preferredPayloadType: 96,
  parameters: {},
};
const sendRtpCapabilities: Media.RtpCapabilities = { codecs: [vp8, h264] };

test('selects the negotiated H.264 codec even when VP8 is first', () => {
  assert.equal(selectScreenShareCodec(sendRtpCapabilities), h264);
  const lowerCase: Media.RtpCodecCapability = {
    ...h264,
    mimeType: 'video/h264',
    parameters: { ...h264.parameters, 'packetization-mode': '1' },
  };
  assert.equal(
    selectScreenShareCodec({ codecs: [{ ...h264, parameters: { 'packetization-mode': 0 } }, lowerCase] }),
    lowerCase,
  );
});

test('prefers negotiated H.264 Main/High over Constrained Baseline for GPU encoding', () => {
  const main: Media.RtpCodecCapability = {
    ...h264,
    preferredPayloadType: 104,
    parameters: { ...h264.parameters, 'profile-level-id': '4d0034' },
  };
  const high: Media.RtpCodecCapability = {
    ...h264,
    preferredPayloadType: 106,
    parameters: { ...h264.parameters, 'profile-level-id': '640034' },
  };
  assert.equal(selectScreenShareCodec({ codecs: [h264, high, main] }), main);
  assert.equal(selectScreenShareCodec({ codecs: [h264, high] }), high);
  assert.equal(
    selectScreenShareCodec({
      codecs: [h264, { ...main, parameters: { ...main.parameters, 'packetization-mode': 0 } }],
    }),
    h264,
  );
  assert.equal(selectScreenShareCodec({ codecs: [h264] }), h264);
});

test('unsupported H.264 fails before allocating a send transport', async () => {
  let created = false;
  const neverTransport = async () => {
    throw new Error('transport must not be created');
  };
  await assert.rejects(
    produceScreenShareVideo(
      async () => {
        created = true;
        return await neverTransport();
      },
      {} as MediaStreamTrack,
      { id: 'unused', label: 'Unused', width: 1920, height: 1080, bitrate: 1_000_000, fps: 30 },
      {},
      { codecs: [vp8, { ...vp8, mimeType: 'video/VP9' }] },
    ),
    /H\.264/,
  );
  assert.equal(created, false);
  assert.throws(() => selectScreenShareCodec({ codecs: [] }), /H\.264/);
});

test('screen sharing uses bps for RTP and kbps for codec hints', () => {
  const options = screenShareEncodingOptions({
    id: 'custom',
    label: 'Custom',
    width: 3840,
    height: 2160,
    bitrate: 24_000_000,
    fps: 60,
  });
  assert.equal(options.encodings[0].maxBitrate, 24_000_000);
  assert.equal(options.encodings[0].scaleResolutionDownBy, 1);
  assert.equal('videoGoogleMinBitrate' in options.codecOptions, false);
  assert.equal(options.codecOptions.videoGoogleStartBitrate, 3_000);
  assert.equal(options.codecOptions.videoGoogleMaxBitrate, 24_000);
});

test('the fixed scale fits the chosen preset while preserving the source aspect ratio', () => {
  const preset = qualityPresets.find((preset) => preset.id === '1080p30');
  assert.ok(preset);
  assert.equal(screenShareEncodingOptions(preset, { width: 3840, height: 2160 }).encodings[0].scaleResolutionDownBy, 2);
  assert.equal(
    screenShareEncodingOptions(preset, { width: 1080, height: 1920 }).encodings[0].scaleResolutionDownBy,
    1920 / 1080,
  );
  assert.equal(screenShareEncodingOptions(preset, { width: 800, height: 600 }).encodings[0].scaleResolutionDownBy, 1);
});

test('each screen gets its own transport and bitrate configuration', async () => {
  const transports: Transport[] = [];
  const producerOptions: Media.ProducerOptions[] = [];
  const createTransport = async (): Promise<Transport> => {
    const transport = {
      produce: async (options: Media.ProducerOptions) => {
        producerOptions.push(options);
        return {
          track: options.track,
          rtpSender: {
            getParameters: () => ({ encodings: [], codecs: [], headerExtensions: [], rtcp: {} }),
            setParameters: async () => {},
          },
        } as unknown as Media.Producer;
      },
      close() {},
    } as unknown as Transport;
    transports.push(transport);
    return transport;
  };
  const first = await produceScreenShareVideo(
    createTransport,
    {} as MediaStreamTrack,
    { id: 'custom-24', label: 'Custom', width: 3840, height: 2160, bitrate: 24_000_000, fps: 60 },
    { label: 'first' },
    sendRtpCapabilities,
  );
  const second = await produceScreenShareVideo(
    createTransport,
    {} as MediaStreamTrack,
    { id: 'custom-8', label: 'Custom', width: 1920, height: 1080, bitrate: 8_000_000, fps: 30 },
    { label: 'second' },
    sendRtpCapabilities,
  );
  assert.notEqual(first.transport, second.transport);
  assert.equal(transports.length, 2);
  const firstOptions = producerOptions[0];
  const secondOptions = producerOptions[1];
  assert.ok(firstOptions && secondOptions);
  assert.equal(firstOptions.codecOptions?.videoGoogleMaxBitrate, 24_000);
  assert.equal(secondOptions.codecOptions?.videoGoogleMaxBitrate, 8_000);
  assert.equal('videoGoogleMinBitrate' in (firstOptions.codecOptions ?? {}), false);
  assert.equal(firstOptions.track?.contentHint, 'motion');
  assert.equal(secondOptions.track?.contentHint, 'motion');
  assert.equal(firstOptions.codec, h264);
  assert.equal(secondOptions.codec, h264);
});

test('every selectable quality uses its own bitrate and frame rate budget', () => {
  assert.equal(new Set(qualityPresets.map((preset) => preset.id)).size, qualityPresets.length);
  for (const preset of qualityPresets) {
    const options = screenShareEncodingOptions(preset);
    assert.equal(options.encodings[0].maxBitrate, preset.bitrate, preset.id);
    assert.equal(options.encodings[0].maxFramerate, preset.fps, preset.id);
    assert.equal('videoGoogleMinBitrate' in options.codecOptions, false, preset.id);
    assert.equal(options.codecOptions.videoGoogleMaxBitrate * 1000, preset.bitrate, preset.id);
    assert.ok(options.codecOptions.videoGoogleStartBitrate * 1000 <= preset.bitrate, preset.id);
  }
  assert.deepEqual(
    qualityPresets.find((preset) => preset.id === '4k60'),
    {
      id: '4k60',
      label: '4K · 60 FPS',
      width: 3840,
      height: 2160,
      fps: 60,
      bitrate: 45_000_000,
    },
  );
});

test('failed video production closes its dedicated transport', async () => {
  let closed = false;
  const failure = new Error('negotiation failed');
  await assert.rejects(
    produceScreenShareVideo(
      async () =>
        ({
          produce: async () => {
            throw failure;
          },
          close: () => {
            closed = true;
          },
        }) as unknown as Transport,
      {} as MediaStreamTrack,
      { id: 'custom', label: 'Custom', width: 3840, height: 2160, bitrate: 24_000_000, fps: 60 },
      {},
      sendRtpCapabilities,
    ),
    (error) => error === failure,
  );
  assert.equal(closed, true);
});

test('resolution preference preserves negotiated sender parameters and motion hint', async () => {
  const parameters = {
    transactionId: 'negotiated',
    encodings: [{ ssrc: 42, maxBitrate: 24_000_000 }],
    codecs: [{ payloadType: 96 }],
    headerExtensions: [],
    rtcp: {},
  } as unknown as RTCRtpSendParameters;
  let applied: RTCRtpSendParameters | undefined;
  await preferScreenShareResolution({
    rtpSender: {
      getParameters: () => parameters,
      setParameters: async (value: RTCRtpSendParameters) => {
        applied = value;
      },
    },
  } as unknown as Media.Producer);
  assert.ok(applied);
  assert.equal(applied, parameters);
  assert.equal(applied.transactionId, 'negotiated');
  assert.deepEqual(applied.encodings, [{ ssrc: 42, maxBitrate: 24_000_000 }]);
  assert.equal(applied.degradationPreference, 'maintain-resolution');
});

test('unsupported resolution preference falls back to a resolution-oriented track hint', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const track = { contentHint: 'motion' } as unknown as MediaStreamTrack;
  assert.equal(
    await preferScreenShareResolution({
      track,
      rtpSender: {
        getParameters: () => ({}),
        setParameters: async () => {
          throw new Error('unsupported');
        },
      },
    } as unknown as Media.Producer),
    false,
  );
  assert.equal(track.contentHint, 'detail');
  assert.equal(warn.mock.callCount(), 1);
  track.contentHint = 'motion';
  assert.equal(await preferScreenShareResolution({ track } as unknown as Media.Producer), false);
  assert.equal(track.contentHint, 'detail');
});

test('measures video over the stats interval, excluding audio and RTX', () => {
  const stats = readStats(
    report(
      { ...video, id: 'audio', kind: 'audio' },
      { ...video, id: 'rtx', codecId: 'rtx-codec' },
      { id: 'rtx-codec', type: 'codec', mimeType: 'video/rtx' },
      {
        ...video,
        timestamp: 3000,
        bytesSent: 6_001_000,
        framesEncoded: 150,
        frameWidth: 2560,
        frameHeight: 1440,
        qualityLimitationReason: 'bandwidth',
        targetBitrate: 24_000_000,
      },
    ),
    video,
  );
  assert.equal(stats.bitrateMbps, 24);
  assert.equal(stats.fps, 60);
  assert.equal(stats.width, 2560);
  assert.equal(stats.limitation, 'bandwidth');
  assert.equal(stats.targetBitrateMbps, 24);
});

test('first sample, stream changes and counter resets do not produce bogus rates', () => {
  assert.equal(readStats(report(video)).bitrateMbps, null);
  assert.equal(readStats(report({ ...video, id: 'new-stream', timestamp: 3000 }), video).bitrateMbps, null);
  assert.equal(readStats(report({ ...video, timestamp: 3000, bytesSent: 0 }), video).bitrateMbps, null);
  assert.equal(readStats(report(video), video).bitrateMbps, null);
  assert.equal(readScreenShareStats(report()), null);
});

test('idle screens retain zero bitrate and zero FPS without artificial padding', () => {
  const stats = readStats(
    report({ ...video, timestamp: 3000, framesPerSecond: 0, qualityLimitationReason: 'none' }),
    video,
  );
  assert.equal(stats.bitrateMbps, 0);
  assert.equal(stats.fps, 0);
  assert.equal(stats.limitation, 'none');
});

test('reports the actual negotiated video codec', () => {
  const stats = readStats(
    report(
      { ...video, codecId: 'h264' },
      {
        id: 'h264',
        type: 'codec',
        mimeType: 'video/H264',
        sdpFmtpLine: 'packetization-mode=1;profile-level-id=4d001f;level-asymmetry-allowed=1',
      },
    ),
  );
  assert.equal(stats.codec, 'video/H264');
  assert.equal(stats.codecProfile, '4d001f');
  assert.equal(readStats(report(video)).codecProfile, undefined);
});

test('separates capture FPS from encoded FPS and measures interval encode time', () => {
  const previous = { ...video, totalEncodeTime: 2 };
  const stats = readStats(
    report(
      {
        ...video,
        timestamp: 3000,
        framesEncoded: 90,
        framesPerSecond: 30,
        totalEncodeTime: 3.2,
        mediaSourceId: 'capture',
        encoderImplementation: 'test-encoder',
      },
      { id: 'capture', type: 'media-source', kind: 'video', framesPerSecond: 60 },
    ),
    previous,
  );
  assert.equal(stats.sourceFps, 60);
  assert.equal(stats.fps, 30);
  assert.ok(typeof stats.encodeMs === 'number');
  assert.ok(Math.abs(stats.encodeMs - 20) < 0.001);
  assert.equal(stats.encoder, 'test-encoder');
  const firstSample = readScreenShareStats(report(video));
  assert.ok(firstSample);
  assert.equal(firstSample.encodeMs, null);
});
