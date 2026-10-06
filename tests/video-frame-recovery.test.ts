import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverVideoFrame } from '../src/video-frame-recovery.ts';

test('missing first frames request a keyframe and recovery stops after presentation', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let presented = () => {};
  let requests = 0;
  let cancelled = 0;
  const video = {
    requestVideoFrameCallback(callback: () => void) {
      presented = callback;
      return 7;
    },
    cancelVideoFrameCallback(id: number) {
      cancelled = id;
    },
  } as unknown as HTMLVideoElement;
  const stop = recoverVideoFrame(video, async () => {
    requests++;
  });
  t.mock.timers.tick(1199);
  assert.equal(requests, 0);
  t.mock.timers.tick(1);
  assert.equal(requests, 1);
  presented();
  t.mock.timers.tick(12000);
  assert.equal(requests, 1);
  stop();
  assert.equal(cancelled, 7);
});

test('recovery is bounded, handles request failure, and cancels on unmount', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let requests = 0;
  const video = { readyState: 0 } as HTMLVideoElement;
  const request = async () => {
    requests++;
    throw new Error('Disconnected');
  };
  const stop = recoverVideoFrame(video, request);
  for (let i = 0; i < 10; i++) t.mock.timers.tick(1200);
  assert.equal(requests, 5);
  stop();
  const unmount = recoverVideoFrame(video, request);
  unmount();
  t.mock.timers.tick(1200);
  assert.equal(requests, 5);
});
