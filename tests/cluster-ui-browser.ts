import type { BrowserHarness } from './browser-harness.ts';
import assert from 'node:assert/strict';

export async function runClusterUiCheck({ evaluate, command }: BrowserHarness) {
  const wait = async (expression: string, sessionId?: string) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression, sessionId)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Cluster UI timed out: ${expression}`);
  };
  const pinSite = (siteId: string, sessionId?: string) =>
    evaluate(
      `(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (args[0] === '/sfu/sites') return new Response(JSON.stringify((await response.json()).filter(site => site.id === '${siteId}')));
      return response;
    };
  })()`,
      sessionId,
    );
  const playing = async (sessionId?: string) => {
    await wait(
      "document.querySelector('.video-wrap video')?.getVideoPlaybackQuality().totalVideoFrames > 3",
      sessionId,
    );
    assert.equal(await evaluate("document.querySelector('.video-wrap video').paused", sessionId), false);
    const frames = await evaluate<number>(
      "document.querySelector('.video-wrap video').getVideoPlaybackQuality().totalVideoFrames",
      sessionId,
    );
    await wait(
      `document.querySelector('.video-wrap video').getVideoPlaybackQuality().totalVideoFrames > ${frames + 2}`,
      sessionId,
    );
    assert.equal(
      await evaluate(
        `(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext('2d');
      context.drawImage(document.querySelector('.video-wrap video'), 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).some(value => value > 20);
    })()`,
        sessionId,
      ),
      true,
      'The received picture is black',
    );
  };
  await wait("Boolean(document.querySelector('.create-card button'))");
  const probes = await evaluate<Array<{ id: string; rtt: number }>>(`(async () => {
    const { probeSfuMedia } = await import('/src/sfu-probe.ts');
    const sites = await (await fetch('/sfu/sites')).json();
    return Promise.all(sites.map(async site => ({ id: site.id, rtt: await probeSfuMedia(site) })));
  })()`);
  assert.equal(probes.length, 3);
  assert.ok(probes.every(({ rtt }) => Number.isFinite(rtt) && rtt >= 0));
  assert.deepEqual(await (await fetch('http://127.0.0.1:13000/internal/rooms')).json(), []);
  await pinSite('a');
  await evaluate(`(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d'); let frame = 0;
      setInterval(() => { context.fillStyle = 'hsl(' + frame++ * 7 + ',80%,50%)'; context.fillRect(0, 0, 640, 360); }, 33);
      return canvas.captureStream(30);
    };
    document.querySelector('.create-card button').click();
  })()`);
  await wait("Boolean(document.querySelector('.share-screen-btn'))");
  await evaluate("document.querySelector('.share-screen-btn').click()");
  await wait("Boolean(document.querySelector('.stream-card'))");
  const roomId = (await (await fetch('http://127.0.0.1:13000/internal/rooms')).json())[0].id;
  const { targetId } = await command('Target.createTarget', { url: 'http://127.0.0.1:15173/' });
  try {
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await wait("Boolean(document.querySelector('.room-join-button'))", sessionId);
    await pinSite('b', sessionId);
    await evaluate("document.querySelector('.room-join-button').click()", sessionId);
    await wait("Boolean(document.querySelector('.stream-card'))", sessionId);
    assert.match(
      await evaluate<string>("document.querySelector('.sfu-connection summary').textContent", sessionId),
      /SFU：b/,
    );
    await playing(sessionId);
    await evaluate("document.querySelector('.screen-expand').click()", sessionId);
    await playing(sessionId);
    await evaluate(
      "[...document.querySelectorAll('.focus-toolbar button')].find(button => button.textContent === '全画面表示').click()",
      sessionId,
    );
    await wait('Boolean(document.fullscreenElement)', sessionId);
    await playing(sessionId);
    await evaluate('document.exitFullscreen()', sessionId);
    await evaluate("document.querySelector('.focus-toolbar button').click()", sessionId);
    await playing(sessionId);
    await evaluate("document.querySelector('.share-screen-btn').click()");
    await wait("document.querySelectorAll('.stream-card').length === 2", sessionId);
    // Focusing each source pauses the other; restoring must receive a new keyframe.
    for (const index of [0, 1, 0]) {
      await evaluate(`document.querySelectorAll('.screen-expand')[${index}].click()`, sessionId);
      await playing(sessionId);
      await evaluate("document.querySelector('.focus-toolbar button').click()", sessionId);
      await wait(
        "[...document.querySelectorAll('.video-wrap video')].every(video => video.readyState >= 2 && !video.paused)",
        sessionId,
      );
    }
    const producerId = await evaluate("document.querySelector('.stream-card').dataset.stream", sessionId);
    const popout = await command('Target.createTarget', {
      url: `http://127.0.0.1:15173/?room=${roomId}&focus=${producerId}`,
    });
    try {
      const attached = await command('Target.attachToTarget', { targetId: popout.targetId, flatten: true });
      await playing(attached.sessionId);
    } finally {
      await command('Target.closeTarget', { targetId: popout.targetId });
    }
    console.log(
      `Cluster UI: room ${roomId}, source A, viewer B, initial/expanded/fullscreen/restored/popout pictures and playback passed`,
    );
  } finally {
    await command('Target.closeTarget', { targetId });
  }
}
