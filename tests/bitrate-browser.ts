import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { qualityPresets } from '../src/quality-presets.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const audioOnly = process.argv.includes('--audio');
const controlsOnly = process.argv.includes('--controls');
const compatibilityOnly = process.argv.includes('--compatibility');
const clusterOnly = process.argv.includes('--cluster');
const inspectGpu = process.argv.includes('--gpu');
const gpuProfile = process.argv.find((arg) => arg.startsWith('--gpu-profile='))?.split('=')[1];
assert.ok(
  !gpuProfile || (inspectGpu && /^[0-9a-f]{4}$/i.test(gpuProfile)),
  'Use --gpu --gpu-profile=<four hex digits>',
);
const browserPage = controlsOnly ? '/' : '/tests/bitrate-browser.html';
const browserPath =
  process.env.BROWSER_BIN ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
assert.ok(browserPath, 'Set BROWSER_BIN to an installed Chromium browser executable');
const profile = await mkdtemp(path.join(os.tmpdir(), 'eigetsu-bitrate-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sfu, vite, chrome, ws;
const edgeProcesses = [];
const clusterSecret = 'local-cluster-test-secret-at-least-32-characters';
const masterEnv = {
  ...process.env,
  PORT: '13000',
  RTC_MIN_PORT: '41000',
  RTC_MAX_PORT: '41100',
  MEDIASOUP_ANNOUNCED_IP: '127.0.0.1',
  MEDIASOUP_LISTEN_IP: '127.0.0.1',
  MEDIASOUP_WORKERS: '1',
  PIPE_LISTEN_IP: '127.0.0.1',
  PIPE_ANNOUNCED_IP: '127.0.0.1',
  SFU_PUBLIC_URL: '',
  SITE_ID: 'local',
  CLUSTER_SECRET: clusterSecret,
  ...(clusterOnly
    ? {
        ROLE: 'master',
        SITE_ID: 'a',
        SFU_PUBLIC_URL: 'http://127.0.0.1:13000',
        CLUSTER_SECRET: clusterSecret,
        PIPE_ANNOUNCED_IP: '127.0.0.1',
        MASTER_STATE_FILE: path.join(profile, 'master-rooms.json'),
      }
    : { ROLE: 'standalone', MASTER_STATE_FILE: '' }),
};
const edgeEnvs = [];
let browserErrors = '';

async function waitFor(url, select = (value) => value) {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const result = select(await response.json());
        if (result) return result;
      }
    } catch {
      // Keep polling while the endpoint is temporarily unavailable.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

try {
  sfu = spawn(process.execPath, ['sfu/index.ts'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: masterEnv,
  });
  sfu.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitFor('http://127.0.0.1:13000/health');
  if (clusterOnly) {
    for (const [siteId, port, minPort] of [
      ['b', 13010, 41200],
      ['c', 13020, 41400],
    ]) {
      const env = {
        ...process.env,
        ROLE: 'sfu',
        SITE_ID: siteId,
        PORT: String(port),
        SFU_PUBLIC_URL: `http://127.0.0.1:${port}`,
        MASTER_URL: 'http://127.0.0.1:13000',
        CLUSTER_SECRET: clusterSecret,
        PIPE_ANNOUNCED_IP: '127.0.0.1',
        RTC_MIN_PORT: String(minPort),
        RTC_MAX_PORT: String(minPort + 100),
        MEDIASOUP_ANNOUNCED_IP: '127.0.0.1',
        MEDIASOUP_LISTEN_IP: '127.0.0.1',
        MEDIASOUP_WORKERS: '1',
        PIPE_LISTEN_IP: '127.0.0.1',
      };
      edgeEnvs.push(env);
      const edge = spawn(process.execPath, ['sfu/index.ts'], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
      });
      edgeProcesses.push(edge);
      edge.stderr.on('data', (chunk) => process.stderr.write(chunk));
      await waitFor(`http://127.0.0.1:${port}/health`);
    }
  }
  vite = await createServer({
    root,
    configFile: false,
    plugins: [react()],
    optimizeDeps: { include: ['mediasoup-client', 'socket.io-client'] },
    server: {
      host: '127.0.0.1',
      port: 15173,
      strictPort: true,
      proxy: {
        '/socket.io': { target: 'http://127.0.0.1:13000', ws: true },
        '/sfu': { target: 'http://127.0.0.1:13000' },
        '/api/rooms': { target: 'http://127.0.0.1:13000', rewrite: () => '/internal/rooms' },
        '/__cluster/a': {
          target: 'http://127.0.0.1:13000',
          rewrite: (value) => value.replace('/__cluster/a', '/internal'),
        },
        '/__cluster/b': {
          target: 'http://127.0.0.1:13010',
          rewrite: (value) => value.replace('/__cluster/b', '/internal'),
        },
        '/__cluster/c': {
          target: 'http://127.0.0.1:13020',
          rewrite: (value) => value.replace('/__cluster/c', '/internal'),
        },
      },
    },
  });
  await vite.listen();
  const browserArgs = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=19222',
    '--remote-allow-origins=http://127.0.0.1:19222',
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:15173${browserPage}`,
  ];
  if (inspectGpu) {
    // Synthetic camera access exposes optional hardware stats without touching
    // a real camera or showing a permission dialog. The sent video is canvas.
    browserArgs.push('--enable-gpu', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream');
  } else browserArgs.push('--disable-gpu');
  if (process.env.BROWSER_NO_SANDBOX === '1') browserArgs.unshift('--no-sandbox');
  chrome = spawn(browserPath, browserArgs, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', (chunk) => {
    browserErrors = (browserErrors + chunk).slice(-8000);
  });
  const tab = await waitFor('http://127.0.0.1:19222/json/list', (tabs) =>
    tabs.find((item) => item.type === 'page' && item.url === `http://127.0.0.1:15173${browserPage}`),
  );
  ws = new WebSocket(tab.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await once(ws, 'open');
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const result = JSON.parse(event.data);
    pending.get(result.id)?.(result);
  };
  const command = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Browser evaluation timed out'));
      }, 30000);
      pending.set(requestId, (response) => {
        clearTimeout(timer);
        pending.delete(requestId);
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result);
      });
      ws.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const evaluate = async (expression, sessionId) => {
    const result = await command(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  if (inspectGpu) {
    const version = await (await fetch('http://127.0.0.1:19222/json/version')).json();
    const browserSocket = new WebSocket(version.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
    try {
      await once(browserSocket, 'open');
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('GPU information timed out')), 15000);
        browserSocket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id !== 1) return;
          clearTimeout(timer);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        };
      });
      browserSocket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }));
      const { gpu } = await response;
      console.log(
        'GPU availability:',
        JSON.stringify({ devices: gpu.devices, featureStatus: gpu.featureStatus, videoEncoding: gpu.videoEncoding }),
      );
    } finally {
      browserSocket.close();
    }
  }
  if (controlsOnly) {
    const { runPlayerControlsCheck } = await import('./player-controls-browser.ts');
    await runPlayerControlsCheck({ evaluate, command, root });
  }
  for (let i = 0; !controlsOnly && i < 50; i++) {
    if ((await evaluate(`typeof window.${audioOnly ? 'runAudioCheck' : 'runBitrateCheck'}`)) === 'function') break;
    if (i === 49) throw new Error('Browser test fixture failed to load');
    await delay(200);
  }
  if (clusterOnly) console.log('Cluster:', JSON.stringify(await evaluate('window.runClusterCheck()')));
  if (audioOnly || clusterOnly) {
    const result = await evaluate(clusterOnly ? 'window.runAudioCheck(13010, 13000)' : 'window.runAudioCheck()');
    const mean = (samples) =>
      [0, 1].map((channel) => samples.reduce((sum, sample) => sum + sample[channel], 0) / samples.length);
    const full = mean(result.full);
    if (full.some((value) => value === 0)) console.log(JSON.stringify(result.debug));
    const half = mean(result.half);
    const quarter = mean(result.quarter);
    for (const channel of [0, 1]) {
      const expected = [0.2, 0.1][channel] / Math.sqrt(2);
      assert.ok(
        Math.abs(full[channel] / expected - 1) < 0.15,
        `Channel ${channel}: source level changed (${full[channel]})`,
      );
      for (const [name, samples] of [
        ['full', result.full],
        ['half', result.half],
        ['quarter', result.quarter],
      ]) {
        const average = mean(samples)[channel];
        assert.ok(
          samples.every((sample) => Math.abs(sample[channel] / average - 1) < 0.08),
          `${name}: channel ${channel} has fluctuating volume`,
        );
      }
      assert.ok(
        Math.abs(half[channel] / full[channel] - 0.5) < 0.04,
        `Channel ${channel}: 50% sender volume was not preserved`,
      );
      assert.ok(
        Math.abs(quarter[channel] / full[channel] - 0.25) < 0.03,
        `Channel ${channel}: unmute did not restore 25% volume`,
      );
    }
    assert.ok(Math.abs(full[0] / full[1] - 2) < 0.15, 'Stereo channels were mixed together');
    for (const samples of [result.muted, result.mutedAfterVolumeChange]) {
      assert.ok(
        samples.every((sample) => sample.every((level) => level < 0.001)),
        'Sender mute did not silence the received audio',
      );
    }
    assert.equal(result.captureHint, 'music');
    assert.equal(result.outputHint, 'music');
    assert.equal(result.sampleRate, 48_000);
    assert.equal(result.codec.clockRate, 48_000);
    assert.equal(result.codec.channels, 2);
    for (const parameter of ['stereo=1', 'maxaveragebitrate=256000', 'maxplaybackrate=48000', 'usedtx=0']) {
      assert.ok(
        result.codec.sdpFmtpLine
          .split(';')
          .map((value) => value.trim())
          .includes(parameter),
        `Missing negotiated Opus parameter: ${parameter}`,
      );
    }
    console.log(
      `audio: stable stereo RMS ${full.map((value) => value.toFixed(4)).join(', ')}; 50%/25% gain and mute passed`,
    );
  }
  if (compatibilityOnly || clusterOnly) {
    console.log(
      'Profile compatibility:',
      JSON.stringify(
        await evaluate(`window.runCompatibilityCheck(${inspectGpu}${clusterOnly ? ', 13010, 13000' : ''})`),
      ),
    );
  }
  if (clusterOnly) {
    const recoveryRoom = await evaluate('window.runClusterCheck(true)');
    const before = await evaluate('window.clusterRecovery.frames()');
    let exited = once(sfu, 'exit');
    sfu.kill();
    await exited;
    await delay(1500);
    const during = await evaluate('window.clusterRecovery.frames()');
    assert.ok(during > before, 'Edge-to-edge video stopped when the master stopped');
    sfu = spawn(process.execPath, ['sfu/index.ts'], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: masterEnv,
    });
    sfu.stderr.on('data', (chunk) => process.stderr.write(chunk));
    await waitFor('http://127.0.0.1:13000/health');
    await waitFor('http://127.0.0.1:13000/sfu/sites', (sites) => sites.length === 3);
    await delay(1500);
    assert.ok(
      (await evaluate('window.clusterRecovery.frames()')) > during,
      'Existing media did not survive master recovery',
    );
    console.log('Cluster: master restart restored metadata while edge-to-edge video continued');

    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    try {
      await command('Page.enable', {}, sessionId);
      await command(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: `
        window.__probes = 0; window.__socketUrls = [];
        const realFetch = window.fetch;
        window.fetch = async (...args) => {
          const url = String(args[0]);
          if (url.includes('/sfu/ping')) {
            window.__probes++;
            await new Promise(resolve => setTimeout(resolve, url.includes(':13010/') ? 0 : 100));
          }
          return realFetch(...args);
        };
        const RealWebSocket = window.WebSocket;
        window.WebSocket = class extends RealWebSocket {
          constructor(...args) {
            super(...args);
            if (String(args[0]).includes('/socket.io/')) window.__socketUrls.push(String(args[0]));
          }
        };
      `,
        },
        sessionId,
      );
      await command('Page.navigate', { url: `http://127.0.0.1:15173/?room=${recoveryRoom.roomId}` }, sessionId);
      const waitPage = async (expression) => {
        for (let i = 0; i < 100; i++) {
          if (await evaluate(expression, sessionId)) return;
          await delay(100);
        }
        throw new Error(`Application condition timed out: ${expression}`);
      };
      await waitPage(
        "window.__socketUrls.some(url => url.includes(':13010/')) && Boolean(document.querySelector('.room-header'))",
      );
      await waitPage("document.querySelector('.stream-card video')?.videoWidth > 0");
      const probes = await evaluate('window.__probes', sessionId);
      const applicationRoom = await evaluate("document.querySelector('.room-code').textContent", sessionId);
      assert.equal(probes, 12, 'Expected warmup and three RTT samples at each site');
      await waitPage(
        "document.querySelector('.sfu-connection')?.textContent.includes('接続先SFU：b') && document.querySelector('.transport-list')?.textContent.includes('UDP')",
      );
      assert.equal(await evaluate("document.querySelector('.sfu-connection a')?.target", sessionId), '_blank');
      await mkdir(path.join(root, 'tmp'), { recursive: true });
      const roomScreenshot = await command('Page.captureScreenshot', { captureBeyondViewport: true }, sessionId);
      await writeFile(path.join(root, 'tmp/sfu-connection.png'), Buffer.from(roomScreenshot.data, 'base64'));
      const statistics = await (await fetch('http://127.0.0.1:13010/sfu/statistics')).json();
      assert.equal(statistics.sites.length, 3);
      assert.ok(statistics.sites.every((site) => site.status === 'online' && site.metrics.workers.length === 1));
      assert.ok(statistics.sites.find((site) => site.id === 'b').metrics.clients.bytesSent > 0);
      assert.ok(statistics.sites.find((site) => site.id === 'c').metrics.pipes.bytesSent > 0);
      const dashboard = await command('Target.createTarget', { url: 'http://127.0.0.1:15173/cluster' });
      try {
        const { sessionId: dashboardSession } = await command('Target.attachToTarget', {
          targetId: dashboard.targetId,
          flatten: true,
        });
        for (let i = 0; i < 100; i++) {
          if (await evaluate("document.querySelectorAll('.sfu-card').length === 3", dashboardSession)) break;
          await delay(100);
        }
        assert.equal(await evaluate("document.querySelectorAll('.sfu-card').length", dashboardSession), 3);
        await mkdir(path.join(root, 'tmp'), { recursive: true });
        await command('Page.enable', {}, dashboardSession);
        await command(
          'Emulation.setDeviceMetricsOverride',
          { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
          dashboardSession,
        );
        await command(
          'Emulation.setEmulatedMedia',
          { features: [{ name: 'prefers-color-scheme', value: 'light' }] },
          dashboardSession,
        );
        const screenshot = await command('Page.captureScreenshot', { captureBeyondViewport: true }, dashboardSession);
        await writeFile(path.join(root, 'tmp/cluster-statistics.png'), Buffer.from(screenshot.data, 'base64'));
        await command(
          'Emulation.setEmulatedMedia',
          { features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
          dashboardSession,
        );
        const darkScreenshot = await command(
          'Page.captureScreenshot',
          { captureBeyondViewport: true },
          dashboardSession,
        );
        await writeFile(path.join(root, 'tmp/cluster-statistics-dark.png'), Buffer.from(darkScreenshot.data, 'base64'));
        await command(
          'Emulation.setDeviceMetricsOverride',
          { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
          dashboardSession,
        );
        assert.ok(
          await evaluate('document.documentElement.scrollWidth <= innerWidth', dashboardSession),
          'Statistics page overflows on mobile',
        );
        const mobileScreenshot = await command(
          'Page.captureScreenshot',
          { captureBeyondViewport: true },
          dashboardSession,
        );
        await writeFile(
          path.join(root, 'tmp/cluster-statistics-mobile.png'),
          Buffer.from(mobileScreenshot.data, 'base64'),
        );
        await evaluate("window.fetch = async () => { throw new Error('simulated outage'); }", dashboardSession);
        await delay(6000);
        assert.ok(
          await evaluate(
            "Boolean(document.querySelector('[role=alert]')) && document.querySelectorAll('.sfu-card').length === 3",
            dashboardSession,
          ),
          'Failed refresh should preserve and label stale statistics',
        );
        console.log('Cluster: statistics page shows all SFUs, live traffic, responsive layout and stale-data warning');
      } finally {
        await command('Target.closeTarget', { targetId: dashboard.targetId });
      }
      exited = once(edgeProcesses[0], 'exit');
      edgeProcesses[0].kill();
      await exited;
      await delay(2500);
      const restarted = spawn(process.execPath, ['sfu/index.ts'], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: edgeEnvs[0],
      });
      edgeProcesses[0] = restarted;
      restarted.stderr.on('data', (chunk) => process.stderr.write(chunk));
      await waitFor('http://127.0.0.1:13010/health');
      await waitFor('http://127.0.0.1:13000/internal/rooms', (rooms) =>
        rooms.some((room) => room.id === applicationRoom && room.peopleCount === 2),
      );
      await waitPage(
        "window.__socketUrls.length > 1 && Boolean(document.querySelector('.room-header')) && !document.body.textContent.includes('接続が切れました')",
      );
      await waitPage("document.querySelector('.stream-card video')?.videoWidth > 0");
      assert.equal(await evaluate('window.__probes', sessionId), probes, 'Reconnection reran SFU selection');
      assert.ok(
        await evaluate("window.__socketUrls.every(url => url.includes(':13010/'))", sessionId),
        'Client migrated to another SFU',
      );
      console.log(
        'Cluster: application selected lowest RTT, decoded remote video and restored it on the same SFU after restart without probing again',
      );
    } finally {
      await command('Target.closeTarget', { targetId });
      await evaluate('window.clusterRecovery.cleanup()');
    }
  }
  for (const [mode, presetId] of audioOnly || controlsOnly || compatibilityOnly || clusterOnly
    ? []
    : gpuProfile
      ? [['fixed', '1080p30']]
      : [
          ['fixed', '1080p30'],
          ['fixed', '4k60'],
          ['fixed-multiple', '1440p60'],
        ]) {
    const preset = qualityPresets.find((item) => item.id === presetId);
    const budgetMbps = preset.bitrate / 1_000_000;
    const result = await evaluate(
      `window.runBitrateCheck('${mode}', '${presetId}', ${inspectGpu}, ${JSON.stringify(gpuProfile)})`,
    );
    const targets = result.samples.map((sample) => sample.targetMbps);
    assert.ok(
      targets.every((target) => Number.isFinite(target) && target > 0 && target <= budgetMbps * 1.05),
      `${mode}/${presetId}: encoder targets exceed the ${budgetMbps} Mbps ceiling: ${targets}`,
    );
    assert.equal(result.encodings[0].maxBitrate, preset.bitrate);
    assert.equal(result.encodings[0].maxFramerate, preset.fps);
    assert.equal(result.contentHint, 'motion');
    assert.equal(result.degradationPreference, 'maintain-resolution');
    assert.ok(
      result.samples.every((sample) => sample.codec?.toLowerCase() === 'video/h264'),
      `${mode}/${presetId}: H.264 was not used`,
    );
    assert.ok(
      result.samples.every((sample) => sample.width === preset.width && sample.height === preset.height),
      `${mode}/${presetId}: sender resolution changed: ${JSON.stringify(result.samples)}`,
    );
    assert.ok(
      result.samples.every(
        (sample) => sample.receivedWidth === preset.width && sample.receivedHeight === preset.height,
      ),
      `${mode}/${presetId}: received resolution changed: ${JSON.stringify(result.samples)}`,
    );
    {
      assert.equal(result.receiver?.codec?.toLowerCase(), 'video/h264');
      assert.ok(result.receiver.framesDecoded > 0, 'The browser did not decode the SFU H.264 stream');
      assert.ok(result.receiver.renderedFrames > 0, 'The browser did not render the SFU H.264 stream');
      assert.equal(result.receiver.bufferTargetMs, 100);
      assert.ok(result.receiver.stats.fps > 0, 'Receiver FPS was not measured');
      assert.ok(result.receiver.stats.decodeMs > 0, 'Receiver decode time was not measured');
      assert.ok(result.receiver.stats.bufferMs > 0, 'Receiver buffer delay was not measured');
      console.log(
        `H.264 receiver: fixed ${preset.width}x${preset.height}, ${result.receiver.framesDecoded} decoded frames, ${result.receiver.renderedFrames} playback frames`,
      );
    }
    console.log(
      `${mode}/${presetId}: H.264 encoder targets ${targets.map((value) => value.toFixed(2)).join(', ')} Mbps`,
    );
    if (inspectGpu) {
      console.log(
        `${presetId} actual encoders:`,
        JSON.stringify(
          result.samples.map((sample) => ({
            encoder: sample.encoder ?? 'unavailable',
            powerEfficient: sample.powerEfficient ?? 'unavailable',
            profile: sample.fmtp,
            width: sample.width,
            height: sample.height,
            fps: sample.fps,
          })),
        ),
      );
    }
  }
  if (inspectGpu) {
    const { targetId } = await command('Target.createTarget', { url: 'chrome://gpu' });
    try {
      const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
      await delay(2000);
      const info = await evaluate(
        `(() => {
        const view = document.querySelector('info-view');
        const text = view?.shadowRoot?.querySelector('#content')?.innerText || view?.shadowRoot?.textContent || document.body.innerText;
        return [['Problems Detected', 'ANGLE Features'], ['Video Acceleration Information', 'Vulkan Information'], ['Log Messages', null]].map(([section, end]) => {
          const start = text.indexOf(section);
          const stop = end ? text.indexOf(end, start) : -1;
          return start < 0 ? section + ': unavailable' : text.slice(start, stop > start ? stop : undefined).trim();
        }).join('\\n\\n');
      })()`,
        sessionId,
      );
      console.log('GPU browser diagnostics:', info);
    } finally {
      await command('Target.closeTarget', { targetId });
    }
  }
} catch (error) {
  if (browserErrors) console.error(browserErrors);
  throw error;
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id: 99999, method: 'Browser.close' }));
    ws.close();
  }
  for (const process of [chrome, ...edgeProcesses, sfu]) {
    if (!process || process.exitCode != null) continue;
    const exited = once(process, 'exit');
    process.kill();
    await Promise.race([exited, delay(1000)]);
  }
  await vite?.close();
  // Only remove the unique browser profile created by this test inside the OS temp directory.
  assert.ok(path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
