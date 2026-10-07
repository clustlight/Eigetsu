import type { BrowserHarnessWithRoot } from './browser-harness.ts';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Bounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}
interface PlayerSnapshot {
  visible: boolean;
  idle: boolean;
  cursor: string;
  opacities: number[];
  top: Bounds;
  bottom: Bounds;
  video: Bounds;
  media: Bounds;
  source: { width: number; height: number };
  fit: string;
  width: number;
  height: number;
  fullscreen: boolean;
  fullscreenIsPlayer: boolean;
}
export async function runPlayerControlsCheck({ evaluate, command, root }: BrowserHarnessWithRoot) {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (expression: string, sessionId?: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression, sessionId)) return;
      await delay(100);
    }
    throw new Error(`Player check timed out: ${expression}`);
  };
  const pointer = async (type: string, pointerType = 'mouse', selector = '.video-wrap video', sessionId?: string) => {
    await evaluate(
      `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      target.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, pointerType: ${JSON.stringify(pointerType)}, clientX: 300, clientY: 150 }));
    })()`,
      sessionId,
    );
    await delay(30);
  };
  const snapshot = (sessionId?: string) =>
    evaluate<PlayerSnapshot>(
      `(() => {
    const player = document.querySelector('.share-grid.is-focused, .focus-window');
    const bars = [...player.querySelectorAll('[data-player-controls]')];
    const video = player.querySelector('.video-wrap');
    const rect = element => { const value = element.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width, height: value.height }; };
    const media = video.querySelector('video');
    return {
      visible: player.classList.contains('controls-visible'),
      idle: player.classList.contains('cursor-idle'),
      cursor: getComputedStyle(video).cursor,
      opacities: bars.map(bar => Number(getComputedStyle(bar).opacity)),
      top: rect(player.querySelector('.focus-toolbar, header')), bottom: rect(player.querySelector('.stream-info, .focus-audio-controls')), video: rect(video),
      media: rect(media), source: { width: media.videoWidth, height: media.videoHeight }, fit: getComputedStyle(media).objectFit,
      width: window.innerWidth, height: window.innerHeight, fullscreen: Boolean(document.fullscreenElement),
      fullscreenIsPlayer: document.fullscreenElement === player
    };
  })()`,
      sessionId,
    );
  const checkLayout = (state: PlayerSnapshot) => {
    if (state.fullscreen) {
      assert.equal(state.fullscreenIsPlayer, true, 'Fullscreen must target the shared-screen player');
      assert.ok(
        Math.abs(state.video.left) <= 1 && Math.abs(state.video.top) <= 1,
        'Fullscreen video has a top/left margin',
      );
      assert.ok(
        Math.abs(state.video.width - state.width) <= 1 && Math.abs(state.video.height - state.height) <= 1,
        'Fullscreen controls reserve space around the video',
      );
      assert.ok(
        Math.abs(state.top.top) <= 1 && Math.abs(state.bottom.bottom - state.height) <= 1,
        'Fullscreen controls must overlay the display edges',
      );
    } else {
      assert.ok(state.top.bottom <= state.video.top + 1, 'Top controls overlap the video');
      assert.ok(state.bottom.top >= state.video.bottom - 1, 'Bottom controls overlap the video');
    }
    assert.ok(state.bottom.left >= 0 && state.bottom.right <= state.width + 1, 'Controls overflow the viewport');
    assert.ok(state.video.width > 0 && state.video.height > 0, 'Video area collapsed');
    assert.equal(state.fit, 'contain', 'Video must preserve its source aspect ratio');
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      assert.ok(Math.abs(state.media[edge] - state.video[edge]) <= 1, `Video escaped its available ${edge} boundary`);
    }
    assert.ok(state.source.width > 0 && state.source.height > 0, 'Source video dimensions missing');
  };
  const checkDiagnostics = async (sessionId?: string) => {
    const before = await snapshot(sessionId);
    assert.equal(await evaluate("Boolean(document.querySelector('.player-diagnostics'))", sessionId), false);
    await evaluate("document.querySelector('.diagnostics-toggle').click()", sessionId);
    await waitFor("Boolean(document.querySelector('.player-diagnostics.is-right .stream-diagnostics'))", sessionId);
    assert.deepEqual((await snapshot(sessionId)).video, before.video, 'Opening diagnostics shrank the video');
    const getPanel = () =>
      evaluate<Pick<Bounds, 'left' | 'right' | 'top' | 'bottom'>>(
        "(() => {const r=document.querySelector('.player-diagnostics').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()",
        sessionId,
      );
    let panel = await getPanel();
    assert.ok(
      panel.left >= before.video.left &&
        panel.right <= before.video.right &&
        panel.top >= before.video.top &&
        panel.bottom <= before.video.bottom,
      'Diagnostic panel overflowed the video area',
    );
    await evaluate("document.querySelector('.diagnostics-toolbar button').click()", sessionId);
    await waitFor("Boolean(document.querySelector('.player-diagnostics.is-left'))", sessionId);
    panel = await getPanel();
    assert.ok(Math.abs(panel.left - before.video.left - 12) <= 1, 'Diagnostics did not move to the left');
    assert.deepEqual((await snapshot(sessionId)).video, before.video, 'Moving diagnostics shrank the video');
    await capture(sessionId ? 'popout-diagnostics.png' : 'expanded-diagnostics.png', sessionId);
    await evaluate("document.querySelector('.diagnostics-toolbar button[aria-label]').click()", sessionId);
    await waitFor("!document.querySelector('.player-diagnostics')", sessionId);
    assert.deepEqual((await snapshot(sessionId)).video, before.video, 'Closing diagnostics resized the video');
    assert.equal(
      await evaluate("document.querySelector('.diagnostics-toggle').getAttribute('aria-expanded')", sessionId),
      'false',
    );
  };
  const tap = async (sessionId?: string) => {
    const point = await evaluate<{ x: number; y: number }>(
      "(() => { const rect = document.querySelector('.video-wrap').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()",
      sessionId,
    );
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] }, sessionId);
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    await delay(50);
  };
  const capture = async (name: string, sessionId?: string) => {
    // Let control opacity transitions and browser painting settle first.
    await delay(180);
    const directory = path.join(root, 'tmp', 'player-controls');
    await mkdir(directory, { recursive: true });
    const metrics = name === 'card-diagnostics.png' ? await command('Page.getLayoutMetrics', {}, sessionId) : null;
    const screenshot = await command(
      'Page.captureScreenshot',
      {
        format: 'png',
        ...(metrics
          ? {
              captureBeyondViewport: true,
              clip: { ...metrics.cssContentSize, scale: 1 },
            }
          : {}),
      },
      sessionId,
    );
    await writeFile(path.join(directory, name), Buffer.from(screenshot.data, 'base64'));
  };

  await waitFor("Boolean(document.querySelector('.create-card button'))");
  await evaluate(`(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const paint = canvas.getContext('2d');
      const draw = () => {
        paint.fillStyle = '#263d50'; paint.fillRect(0, 0, canvas.width, canvas.height);
        paint.strokeStyle = '#72ead2'; paint.lineWidth = 12;
        paint.beginPath(); paint.arc(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) / 3, 0, Math.PI * 2); paint.stroke();
        paint.strokeStyle = '#d9edf7'; paint.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
        paint.fillStyle = '#d9edf7'; paint.font = '28px sans-serif'; paint.fillText(canvas.width + ' x ' + canvas.height, 32, 54);
      };
      draw();
      const audio = new AudioContext();
      await audio.resume();
      const destination = audio.createMediaStreamDestination();
      const stream = new MediaStream([...canvas.captureStream(30).getTracks(), ...destination.stream.getTracks()]);
      const timer = setInterval(() => { paint.fillStyle = '#263d50'; paint.fillRect(0, 0, 2, 2); }, 100);
      window.playerCheckCapture = { canvas, stream, audio, timer, draw };
      return stream;
    };
    document.querySelector('.create-card button').click();
  })()`);
  await waitFor("Boolean(document.querySelector('.share-screen-btn'))");
  await evaluate("document.querySelector('.share-screen-btn').click()");
  await waitFor("Boolean(document.querySelector('.stream-card .mute-toggle'))");
  await waitFor("document.querySelector('.stream-diagnostics')?.textContent.includes('送信:')");
  assert.ok((await evaluate<string>("document.querySelector('.stream-quality').textContent")).includes('FPS'));
  assert.equal(await evaluate("document.querySelector('.stream-quality').hasAttribute('title')"), false);
  assert.equal(
    await evaluate(
      "(() => {const card=document.querySelector('.stream-card'); return card.querySelector('.stream-diagnostics').getBoundingClientRect().top >= card.querySelector('.stream-info').getBoundingClientRect().bottom;})()",
    ),
    true,
  );
  await capture('card-diagnostics.png');
  await evaluate("document.querySelector('.screen-expand').click()");
  await waitFor("Boolean(document.querySelector('.share-grid.is-focused.controls-visible'))");
  checkLayout(await snapshot());
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.video-overlay')).display"), 'none');
  await capture('expanded.png');
  await checkDiagnostics();
  for (const [width, height, name] of [
    [960, 720, 'four-three'],
    [720, 1280, 'portrait'],
    [1680, 720, 'ultrawide'],
    [1280, 720, 'wide'],
  ]) {
    await evaluate(
      `(() => { const capture = window.playerCheckCapture; capture.canvas.width = ${width}; capture.canvas.height = ${height}; capture.draw(); })()`,
    );
    await waitFor(
      `document.querySelector('.video-wrap video').videoWidth === ${width} && document.querySelector('.video-wrap video').videoHeight === ${height}`,
    );
    await pointer('pointermove');
    checkLayout(await snapshot());
    await capture(`expanded-${name}.png`);
  }

  await pointer('pointermove');
  await delay(2200);
  let state = await snapshot();
  assert.equal(state.visible, false);
  assert.equal(state.idle, true);
  assert.equal(state.cursor, 'none');
  assert.ok(
    state.opacities.every((opacity) => opacity === 0),
    'Both control bars must hide',
  );
  await pointer('pointermove');
  assert.equal((await snapshot()).cursor, 'default');
  assert.equal((await snapshot()).visible, true);

  // Controls stay usable while a slider is held, then resume the idle timeout.
  await pointer('pointerdown', 'mouse', '.stream-info input');
  await delay(2200);
  assert.equal((await snapshot()).visible, true);
  await pointer('pointerup', 'mouse', '.stream-info input');
  await delay(2200);
  assert.equal((await snapshot()).visible, false);

  // Keyboard focus pins both bars without leaving the cursor hidden.
  await evaluate("document.querySelector('.focus-toolbar button').focus()");
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await waitFor("document.querySelector('.share-grid.is-focused').contains(document.activeElement)");
  await delay(2200);
  assert.equal((await snapshot()).visible, true);
  assert.notEqual((await snapshot()).cursor, 'none');
  await evaluate('document.activeElement.blur()');

  await pointer('pointermove');
  await evaluate(
    "[...document.querySelectorAll('.focus-toolbar button')].find(button => button.textContent === '全画面表示').click()",
  );
  await waitFor('Boolean(document.fullscreenElement)');
  checkLayout(await snapshot());
  await capture('fullscreen.png');
  await checkDiagnostics();
  await evaluate('(() => {const c=window.playerCheckCapture;c.canvas.width=720;c.canvas.height=1280;c.draw();})()');
  await waitFor(
    "document.querySelector('.video-wrap video').videoWidth === 720 && document.querySelector('.video-wrap video').videoHeight === 1280",
  );
  await pointer('pointermove');
  checkLayout(await snapshot());
  await capture('fullscreen-portrait.png');
  await evaluate('(() => {const c=window.playerCheckCapture;c.canvas.width=1280;c.canvas.height=720;c.draw();})()');
  await waitFor(
    "document.querySelector('.video-wrap video').videoWidth === 1280 && document.querySelector('.video-wrap video').videoHeight === 720",
  );
  await delay(2200);
  await tap();
  await pointer('pointerleave', 'touch');
  assert.equal((await snapshot()).visible, true, 'Touch leave must not hide controls immediately');
  await tap();
  await pointer('pointermove', 'touch');
  await pointer('pointerleave', 'touch');
  assert.equal((await snapshot()).visible, false, 'Second tap must explicitly hide controls');
  await evaluate("document.querySelector('.video-wrap').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  assert.equal((await snapshot()).fullscreen, true, 'Double tap must not exit fullscreen');
  await tap();
  assert.equal((await snapshot()).visible, true);
  await delay(2200);
  state = await snapshot();
  assert.equal(state.visible, false, 'Touch-revealed controls must time out');
  checkLayout(state);
  await capture('fullscreen-idle.png');
  await evaluate('document.exitFullscreen()');
  await waitFor('!document.fullscreenElement');
  checkLayout(await snapshot());

  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pointer('pointermove');
  checkLayout(await snapshot());
  await capture('mobile.png');
  await checkDiagnostics();
  await command('Emulation.clearDeviceMetricsOverride');

  await pointer('pointermove');
  await evaluate("document.querySelector('.stream-info .screen-popout').click()");
  let target;
  for (let attempt = 0; attempt < 50; attempt++) {
    const targets = await command('Target.getTargets');
    target = targets.targetInfos.find((target) => target.type === 'page' && target.url.includes('focus='));
    if (target) break;
    await delay(100);
  }
  assert.ok(target, 'Popout did not open');
  const { sessionId } = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await waitFor("Boolean(document.querySelector('.focus-window video'))", sessionId);
  await waitFor("document.querySelector('.focus-window video').readyState >= 2", sessionId);
  await checkDiagnostics(sessionId);
  await evaluate("document.querySelector('.diagnostics-toggle').click()", sessionId);
  await waitFor(
    "document.querySelector('.focus-window .stream-diagnostics')?.textContent.includes('再生:')",
    sessionId,
  );
  const receivedDiagnostics = await evaluate<string>(
    "document.querySelector('.focus-window .stream-diagnostics').textContent",
    sessionId,
  );
  for (const field of ['受信:', 'デコード:', '受信バッファ実測:', '再生破棄:']) {
    assert.ok(receivedDiagnostics.includes(field), `Missing receiver diagnosis: ${field}`);
  }
  await evaluate("document.querySelector('.diagnostics-toggle').click()", sessionId);
  await pointer('pointermove', 'mouse', '.video-wrap video', sessionId);
  checkLayout(await snapshot(sessionId));
  await capture('popout.png', sessionId);
  await command(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  await pointer('pointermove', 'mouse', '.video-wrap video', sessionId);
  checkLayout(await snapshot(sessionId));
  await capture('popout-mobile.png', sessionId);
  await checkDiagnostics(sessionId);
  await command('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  await evaluate(
    "[...document.querySelectorAll('.focus-window-actions button')].find(button => button.textContent === '全画面表示').click()",
    sessionId,
  );
  await waitFor('Boolean(document.fullscreenElement)', sessionId);
  await pointer('pointermove', 'mouse', '.video-wrap video', sessionId);
  checkLayout(await snapshot(sessionId));
  await capture('popout-fullscreen.png', sessionId);
  await checkDiagnostics(sessionId);
  await delay(2200);
  state = await snapshot(sessionId);
  assert.equal(state.cursor, 'none');
  checkLayout(state);
  await capture('popout-fullscreen-idle.png', sessionId);
  await tap(sessionId);
  assert.equal((await snapshot(sessionId)).visible, true);
  await tap(sessionId);
  assert.equal((await snapshot(sessionId)).visible, false);
  console.log(
    'player controls: aspect ratio, floating diagnostic toggles/position, expanded/fullscreen/popout layout, idle cursor, touch toggle, slider and keyboard checks passed',
  );
}
