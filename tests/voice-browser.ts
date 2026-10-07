import type { BrowserHarnessWithRoot } from './browser-harness.ts';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function runVoiceCheck({ evaluate, command, root }: BrowserHarnessWithRoot) {
  const wait = async (expression: string, sessionId?: string) => {
    for (let i = 0; i < 120; ++i) {
      if (await evaluate(expression, sessionId)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const detail = await evaluate(
      "({text: document.body.innerText, clientId: localStorage.getItem('eigetsu-client-id'), errors: window.voiceErrors})",
      sessionId,
    );
    throw new Error(`VC check timed out: ${expression}; ${JSON.stringify(detail)}`);
  };
  const click = (text: string, sessionId?: string) =>
    evaluate(
      `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`,
      sessionId,
    );
  const setup = (site: string, sessionId?: string) =>
    evaluate(
      `(() => {
    const original = window.fetch;
    window.voiceErrors = [];
    for (const key of ['error', 'warn']) {
      const originalLog = console[key];
      console[key] = (...args) => { window.voiceErrors.push(args.map(value => value?.message || String(value)).join(' ')); originalLog(...args); };
    }
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (args[0] === '/sfu/sites') return new Response(JSON.stringify((await response.json()).filter(site => site.id === '${site}')));
      return response;
    };
    window.voiceCaptures = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.voiceConstraints = constraints;
      const context = new AudioContext({ sampleRate: 48000 });
      await context.resume();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 997;
      const gain = context.createGain(); gain.gain.value = 0.15;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination); oscillator.start();
      window.voiceCaptures.push({ context, stream: destination.stream });
      return destination.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d'); let frame = 0;
      setInterval(() => { context.fillStyle = 'hsl(' + frame++ * 7 + ',80%,50%)'; context.fillRect(0, 0, 640, 360); }, 33);
      return canvas.captureStream(30);
    };
  })()`,
      sessionId,
    );
  await wait("Boolean(document.querySelector('.create-card button'))");
  await setup('a');
  await evaluate("document.querySelector('.create-card button').click()");
  await wait("Boolean(document.querySelector('.voice-chat'))");
  assert.match(await evaluate<string>("document.querySelector('.voice-chat strong').textContent"), /オフ/);
  assert.equal(await evaluate('window.voiceCaptures.length'), 0);
  await click('ルームのVCを有効にする');
  await wait("document.querySelector('.voice-chat strong').textContent.includes('オン')");
  assert.equal(await evaluate('window.voiceCaptures.length'), 0);
  await click('マイクを開始');
  await wait("document.querySelectorAll('[data-voice-stream]').length === 1");
  const constraints = await evaluate<MediaStreamConstraints>('window.voiceConstraints');
  assert.equal(constraints.video, false);
  for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const)
    assert.equal((constraints.audio as MediaTrackConstraints)[key], false);
  assert.equal(await evaluate('window.voiceCaptures[0].stream.getAudioTracks()[0].contentHint'), 'music');

  // Set a distinct client ID before the viewer application loads.
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  try {
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Page.enable', {}, sessionId);
    await command(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: "localStorage.setItem('eigetsu-client-id', 'voice-check-viewer')",
      },
      sessionId,
    );
    await command('Page.navigate', { url: 'http://127.0.0.1:15173/' }, sessionId);
    await wait("Boolean(document.querySelector('.room-join-button'))", sessionId);
    await setup('b', sessionId);
    await evaluate("document.querySelector('.room-join-button').click()", sessionId);
    await wait("document.querySelectorAll('[data-voice-stream]').length === 1", sessionId);
    assert.match(
      await evaluate<string>("document.querySelector('.sfu-connection summary').textContent", sessionId),
      /SFU：b/,
    );
    assert.equal(await evaluate('window.voiceCaptures.length', sessionId), 0);
    await wait("document.querySelector('.voice-stream audio')?.readyState >= 2", sessionId);
    await evaluate(
      `(async () => {
      const audio = document.querySelector('.voice-stream audio');
      const context = new AudioContext(); await context.resume();
      const source = context.createMediaStreamSource(audio.srcObject);
      const analyser = context.createAnalyser(); analyser.fftSize = 2048;
      source.connect(analyser);
      window.voiceRms = () => {
        const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
        return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
      };
    })()`,
      sessionId,
    );
    await wait('window.voiceRms() > 0.03', sessionId);
    await click('マイクを開始', sessionId);
    await wait("document.querySelectorAll('[data-voice-stream]').length === 2");
    await wait("document.querySelectorAll('[data-voice-stream]').length === 2", sessionId);
    await evaluate("document.querySelector('.voice-stream button').click()");
    await wait('window.voiceRms() < 0.001', sessionId);
    await evaluate("document.querySelector('.voice-stream button').click()");
    await wait('window.voiceRms() > 0.03', sessionId);
    await evaluate("document.querySelector('.share-screen-btn').click()");
    await wait(
      "document.querySelector('.video-wrap video')?.getVideoPlaybackQuality().totalVideoFrames > 3",
      sessionId,
    );
    await evaluate("document.querySelector('.screen-expand').click()", sessionId);
    await wait('window.voiceRms() > 0.03', sessionId);
    assert.equal(await evaluate("document.querySelectorAll('[data-voice-stream]').length", sessionId), 2);

    await evaluate("document.querySelector('.focus-toolbar button').click()", sessionId);
    await evaluate('window.scrollTo(0, 0)', sessionId);
    await command(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );

    const directory = path.join(root, 'tmp', 'voice-chat');
    await mkdir(directory, { recursive: true });
    const screenshot = await command('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(directory, 'voice-room.png'), Buffer.from(screenshot.data, 'base64'));

    await click('ルームのVCを無効にする', sessionId);
    for (const session of [undefined, sessionId]) {
      await wait("document.querySelector('.voice-chat strong').textContent.includes('オフ')", session);
      await wait("document.querySelectorAll('[data-voice-stream]').length === 0", session);
      assert.equal(
        await evaluate(
          'window.voiceCaptures.every(capture => capture.stream.getTracks().every(track => track.readyState === "ended"))',
          session,
        ),
        true,
      );
    }
    const before = await evaluate<number>(
      "document.querySelector('.video-wrap video').getVideoPlaybackQuality().totalVideoFrames",
      sessionId,
    );
    await wait(
      `document.querySelector('.video-wrap video').getVideoPlaybackQuality().totalVideoFrames > ${before + 3}`,
      sessionId,
    );
    await click('ルームのVCを有効にする');
    await wait("document.querySelector('.voice-chat strong').textContent.includes('オン')", sessionId);
    assert.equal(await evaluate('window.voiceCaptures.length'), 1);
    assert.equal(await evaluate('window.voiceCaptures.length', sessionId), 1);
    await click('マイクを開始');
    await wait("document.querySelectorAll('[data-voice-stream]').length === 1", sessionId);
    await click('マイクを停止');
    await wait("document.querySelectorAll('[data-voice-stream]').length === 0", sessionId);
    assert.match(await evaluate<string>("document.querySelector('.voice-chat strong').textContent", sessionId), /オン/);
    await click('マイクを開始');
    await wait("document.querySelectorAll('[data-voice-stream]').length === 1", sessionId);
    await click('退出');
    await wait("document.querySelectorAll('[data-voice-stream]').length === 0", sessionId);
    console.log(
      'VC: default off, late join, bidirectional inter-SFU audio, capture constraints, mute, focused screen coexistence, disable/re-enable and leave passed',
    );
  } finally {
    await command('Target.closeTarget', { targetId });
  }
}
