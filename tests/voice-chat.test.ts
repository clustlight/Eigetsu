import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceChatSession, type VoiceState } from '../src/voice-chat.ts';
import type { CreateSendTransport, Producer, Transport } from '../src/types.ts';

function fixture() {
  let captures = 0;
  let productions = 0;
  let transportClosed = false;
  let trackStopped = false;
  const announcedClosed: string[] = [];
  let state: VoiceState = { enabled: false, starting: false, streams: [] };
  const track = {
    readyState: 'live',
    enabled: true,
    contentHint: '',
    stop: () => {
      trackStopped = true;
    },
  } as MediaStreamTrack;
  const capture = { getAudioTracks: () => [track], getTracks: () => [track] } as MediaStream;
  const mockProducer = {
    id: 'voice',
    closed: false,
    on() {},
    close() {
      this.closed = true;
    },
  };
  const producer = mockProducer as unknown as Producer;
  const transport = {
    on() {},
    async produce(options: Parameters<Transport['produce']>[0]) {
      ++productions;
      assert.equal(options?.appData?.voiceChat, true);
      assert.equal(options?.appData?.videoProducerId, undefined);
      assert.equal(options?.codecOptions?.opusDtx, false);
      assert.equal(options?.track, track);
      return producer;
    },
    close() {
      transportClosed = true;
    },
  } as unknown as Transport;
  const options = {
    peerId: 'alice',
    name: 'Alice',
    clientId: 'client',
    createSendTransport: (async (parentId) => {
      assert.equal(parentId, undefined);
      return transport;
    }) as CreateSendTransport,
    closeProducer: (id: string) => announcedClosed.push(id),
    onChange: (value: VoiceState) => {
      state = value;
    },
    capture: async (constraints: MediaStreamConstraints) => {
      ++captures;
      assert.equal(constraints.video, false);
      const audio = constraints.audio as MediaTrackConstraints;
      assert.equal(audio.echoCancellation, false);
      assert.equal(audio.noiseSuppression, false);
      assert.equal(audio.autoGainControl, false);
      return capture;
    },
  };
  return {
    options,
    capture,
    track,
    producer,
    transport,
    announcedClosed,
    state: () => state,
    counts: () => ({ captures, productions, transportClosed, trackStopped }),
  };
}

test('VC starts off, sends exactly one independent stream, and releases the microphone when disabled', async () => {
  const f = fixture();
  const session = new VoiceChatSession(f.options);
  await session.start();
  assert.equal(f.counts().captures, 0);
  session.setEnabled(true);
  assert.equal(f.counts().captures, 0, 'Enabling a room does not request microphone access');
  await Promise.all([session.start(), session.start()]);
  await session.start();
  assert.equal(f.counts().captures, 1);
  assert.equal(f.counts().productions, 1);
  assert.equal(f.state().streams.length, 1);
  assert.equal(f.track.contentHint, 'music');
  session.toggleMute('voice');
  assert.equal(f.track.enabled, false);
  session.toggleMute('voice');
  assert.equal(f.track.enabled, true);
  session.setEnabled(false);
  assert.equal(f.state().streams.length, 0);
  assert.equal(f.counts().trackStopped, true);
  assert.equal(f.counts().transportClosed, true);
  assert.deepEqual(f.announcedClosed, ['voice']);
});

test('disabling and re-enabling VC while permission is pending never starts the old microphone request', async () => {
  const f = fixture();
  let resolveCapture!: (value: MediaStream) => void;
  f.options.capture = () =>
    new Promise((resolve) => {
      resolveCapture = resolve;
    });
  const session = new VoiceChatSession(f.options);
  session.setEnabled(true);
  const pending = session.start();
  session.setEnabled(false);
  session.setEnabled(true);
  resolveCapture(f.capture);
  await pending;
  assert.equal(f.counts().productions, 0);
  assert.equal(f.counts().trackStopped, true);
  assert.equal(f.state().starting, false);
  assert.equal(f.state().streams.length, 0);
});

test('leaving during producer negotiation closes the late producer and capture', async () => {
  const f = fixture();
  let finish!: (value: Producer) => void;
  let started!: () => void;
  const producing = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.transport.produce = (() => {
    started();
    return new Promise<Producer>((resolve) => {
      finish = resolve;
    });
  }) as Transport['produce'];
  const session = new VoiceChatSession(f.options);
  session.setEnabled(true);
  const pending = session.start();
  await producing;
  session.close();
  assert.equal(f.counts().trackStopped, true, 'Leaving stops capture immediately, even before signaling completes');
  assert.equal(f.counts().transportClosed, true);
  finish(f.producer);
  await pending;
  assert.equal(f.counts().trackStopped, true);
  assert.equal(f.counts().transportClosed, true);
  assert.equal(f.producer.closed, true);
  assert.deepEqual(f.announcedClosed, ['voice']);
  assert.equal(f.state().streams.length, 0);
});

test('microphone denial leaves VC retryable without leaking a transport', async () => {
  const f = fixture();
  f.options.capture = async () => {
    throw new Error('Permission denied');
  };
  const session = new VoiceChatSession(f.options);
  session.setEnabled(true);
  await assert.rejects(session.start(), /Permission denied/);
  assert.equal(f.state().starting, false);
  assert.equal(f.counts().productions, 0);
  session.close();
});
