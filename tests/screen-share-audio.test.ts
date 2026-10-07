import assert from 'node:assert/strict';
import { test } from 'node:test';
import { produceScreenShareAudio, screenShareCaptureOptions, setSharedAudioGain } from '../src/screen-share-audio.ts';
import { qualityPresets } from '../src/quality-presets.ts';
import type { AudioGain, CreateSendTransport } from '../src/types.ts';

test('every screen preset disables voice processing without changing video quality', () => {
  for (const preset of qualityPresets) {
    const options = screenShareCaptureOptions(preset);
    assert.equal(options.audio.autoGainControl, false);
    assert.equal(options.audio.noiseSuppression, false);
    assert.equal(options.audio.echoCancellation, false);
    assert.equal(options.audio.suppressLocalAudioPlayback, false);
    assert.equal(options.audio.channelCount.ideal, 2);
    assert.equal(options.video.width.ideal, preset.width);
    assert.equal(options.video.height.ideal, preset.height);
    assert.equal(options.video.width.max, undefined);
    assert.equal(options.video.height.max, undefined);
    assert.equal(options.video.frameRate.max, preset.fps);
  }
});

test('sender volume changes stay muted and unmuting restores the selected level', () => {
  const values: Array<[value: number, time: number, smoothing: number]> = [];
  const audioGain: AudioGain = {
    context: { currentTime: 12 } as unknown as AudioGain['context'],
    gain: {
      setTargetAtTime: (value: number, time: number, smoothing: number) => values.push([value, time, smoothing]),
    },
  };
  setSharedAudioGain(audioGain, 0.5);
  setSharedAudioGain(audioGain, 0.5, true);
  setSharedAudioGain(audioGain, 0.25, true);
  setSharedAudioGain(audioGain, 0.25, false);
  assert.deepEqual(
    values.map((value) => value[0]),
    [0.5, 0, 0, 0.25],
  );
  assert.ok(values.every(([, time, smoothing]) => time === 12 && smoothing > 0));
  setSharedAudioGain(audioGain, 2);
  setSharedAudioGain(audioGain, -1);
  setSharedAudioGain(audioGain, NaN);
  assert.deepEqual(
    values.slice(4).map((value) => value[0]),
    [1, 0],
  );
});

test('audio negotiation failures release the generated track, context and transport', async (t) => {
  const output = { stop: t.mock.fn() };
  const context = {
    resume: async () => {},
    close: t.mock.fn(async () => {}),
    createMediaStreamSource: () => ({ connect: () => ({ connect() {} }) }),
    createGain: () => ({ gain: { value: 0 } }),
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [output] } }),
  };
  const implementations: Record<string, unknown> = {
    AudioContext: function () {
      return context;
    },
    MediaStream: function () {},
  };
  for (const [name, implementation] of Object.entries(implementations)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: implementation });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const failure = new Error('negotiation failed');
  const transport = {
    produce: async () => {
      throw failure;
    },
    close: t.mock.fn(),
  };
  const createTransport: CreateSendTransport = async (producerId) => {
    assert.equal(producerId, 'screen');
    return transport as unknown as Awaited<ReturnType<CreateSendTransport>>;
  };
  await assert.rejects(
    produceScreenShareAudio(createTransport, {} as MediaStreamTrack, { videoProducerId: 'screen' }),
    (error) => error === failure,
  );
  assert.equal(output.stop.mock.callCount(), 1);
  assert.equal(context.close.mock.callCount(), 1);
  assert.equal(transport.close.mock.callCount(), 1);
});
