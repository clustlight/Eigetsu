import { Device } from 'mediasoup-client';
import { io } from 'socket.io-client';
import {
  screenShareEncodingOptions,
  preferScreenShareResolution,
  produceScreenShareVideo,
  selectScreenShareCodec,
} from '/src/screen-share-quality.ts';
import { qualityPresets } from '/src/quality-presets.ts';
import { produceScreenShareAudio } from '/src/screen-share-audio.ts';
import './audio-browser-page.ts';
import './compatibility-browser-page.ts';
import './cluster-browser-page.ts';
import { configureScreenShareReceiver, readScreenReceiveStats } from '/src/screen-share-receive.ts';

window.runBitrateCheck = async (mode = 'fixed', presetId = '1440p60', inspectHardware = false, profilePrefix) => {
  const preset = qualityPresets.find((item) => item.id === presetId);
  if (!preset) throw new Error(`Unknown preset: ${presetId}`);
  const socket = io('http://127.0.0.1:13000', { transports: ['websocket'] });
  const rpc = (event, payload = {}) =>
    new Promise((resolve, reject) =>
      socket
        .timeout(10000)
        .emit(event, payload, (err, result) =>
          err ? reject(err) : result.ok ? resolve(result) : reject(new Error(result.error)),
        ),
    );
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const room = await rpc('room:create', { name: 'bitrate-check' });
  const device = new Device();
  await device.load({ routerRtpCapabilities: room.rtpCapabilities });
  const sendRtpCapabilities = profilePrefix
    ? {
        ...device.sendRtpCapabilities,
        codecs: device.sendRtpCapabilities.codecs.filter(
          (codec) =>
            codec.mimeType.toLowerCase() === 'video/h264' &&
            codec.parameters?.['profile-level-id']?.startsWith(profilePrefix),
        ),
      }
    : device.sendRtpCapabilities;
  const codec = selectScreenShareCodec(sendRtpCapabilities);
  const createTransport = async (direction = 'send') => {
    const info = await rpc('transport:create', { direction });
    const transport = device[direction === 'send' ? 'createSendTransport' : 'createRecvTransport'](info);
    transport.observer.once('close', () => socket.emit('transport:close', { transportId: transport.id }));
    transport.on('connect', ({ dtlsParameters }, ok, fail) =>
      rpc('transport:connect', { transportId: transport.id, dtlsParameters }).then(ok, fail),
    );
    transport.on('produce', ({ kind, rtpParameters, appData }, ok, fail) =>
      rpc('produce', { transportId: transport.id, kind, rtpParameters, appData }).then(({ id }) => ok({ id }), fail),
    );
    return transport;
  };
  const canvas = document.createElement('canvas');
  canvas.width = preset.width;
  canvas.height = preset.height;
  const context = canvas.getContext('2d');
  let frame = 0;
  const paint = () => {
    const t = frame++;
    for (let y = 0; y < canvas.height; y += 80) {
      for (let x = 0; x < canvas.width; x += 80) {
        context.fillStyle = `hsl(${(t * 7 + x * 3 + y * 5) % 360},80%,50%)`;
        context.fillRect(x, y, 80, 80);
      }
    }
  };
  paint();
  const paintTimer = setInterval(paint, 1000 / preset.fps);
  const track = canvas.captureStream(preset.fps).getVideoTracks()[0];
  track.contentHint = 'motion';
  let transport;
  let producer;
  if (mode.startsWith('fixed')) {
    ({ transport, producer } = await produceScreenShareVideo(createTransport, track, preset, {}, sendRtpCapabilities));
  } else {
    transport = await createTransport();
    const options = screenShareEncodingOptions(preset);
    options.codecOptions.videoGoogleMinBitrate = Math.round((preset.bitrate * 0.8) / 1000);
    producer = await transport.produce({ track, codec, ...options });
    await preferScreenShareResolution(producer);
  }
  // Negotiate audio after video, using a separate transport for the fixed modes.
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  const audioShare = mode.startsWith('fixed')
    ? await produceScreenShareAudio(createTransport, destination.stream.getAudioTracks()[0], {})
    : null;
  const audioTransport = audioShare?.transport || transport;
  const audioProducer =
    audioShare?.producer ||
    (mode === 'video-only'
      ? null
      : await audioTransport.produce({
          track: destination.stream.getAudioTracks()[0],
          codecOptions: { opusStereo: true, opusMaxAverageBitrate: 192_000, opusFec: true },
        }));
  const secondVideo =
    mode === 'fixed-multiple'
      ? await produceScreenShareVideo(
          createTransport,
          track.clone(),
          qualityPresets.find((item) => item.id === '720p30'),
          {},
          device.sendRtpCapabilities,
        )
      : null;
  const samples = [];
  let recvTransport;
  let consumer;
  let playback;
  let previousReceive;
  let measuredReceive;
  let diagnosticCamera;
  try {
    if (inspectHardware) diagnosticCamera = await navigator.mediaDevices.getUserMedia({ video: true });
    // Observe real received dimensions as well as sender parameters, including
    // the 4K workload that previously triggered automatic downscaling.
    {
      recvTransport = await createTransport('recv');
      const info = await rpc('consume', {
        transportId: recvTransport.id,
        producerId: producer.id,
        rtpCapabilities: device.recvRtpCapabilities,
      });
      consumer = await recvTransport.consume(info);
      configureScreenShareReceiver(consumer);
      playback = document.createElement('video');
      playback.muted = true;
      playback.playsInline = true;
      playback.srcObject = new MediaStream([consumer.track]);
      document.body.append(playback);
      await rpc('consumer:resume', { consumerId: consumer.id });
      await playback.play();
    }
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const stats = await producer.getStats();
      if (consumer) {
        measuredReceive = readScreenReceiveStats(await consumer.getStats(), previousReceive);
        previousReceive = measuredReceive?.sample;
      }
      const outbound = [...stats.values()].find((s) => s.type === 'outbound-rtp' && s.kind === 'video');
      const transportStats = await transport.getStats();
      const pair = [...transportStats.values()].find(
        (s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded',
      );
      samples.push({
        targetMbps: outbound?.targetBitrate / 1e6,
        bytesSent: outbound?.bytesSent,
        fps: outbound?.framesPerSecond,
        width: outbound?.frameWidth,
        height: outbound?.frameHeight,
        limitation: outbound?.qualityLimitationReason,
        codec: stats.get(outbound?.codecId)?.mimeType,
        fmtp: stats.get(outbound?.codecId)?.sdpFmtpLine,
        encoder: outbound?.encoderImplementation,
        powerEfficient: outbound?.powerEfficientEncoder,
        availableMbps: pair?.availableOutgoingBitrate / 1e6,
        receivedWidth: measuredReceive?.width,
        receivedHeight: measuredReceive?.height,
      });
    }
    const parameters = producer.rtpSender.getParameters();
    const receiverStats = consumer ? await consumer.getStats() : null;
    const inbound =
      receiverStats && [...receiverStats.values()].find((stat) => stat.type === 'inbound-rtp' && stat.kind === 'video');
    const receiver = inbound
      ? {
          codec: receiverStats.get(inbound.codecId)?.mimeType,
          framesDecoded: inbound.framesDecoded,
          renderedFrames: playback.getVideoPlaybackQuality().totalVideoFrames,
          bufferTargetMs: consumer.rtpReceiver.jitterBufferTarget,
          stats: measuredReceive,
        }
      : null;
    return {
      mode,
      presetId,
      samples,
      receiver,
      encodings: parameters.encodings,
      contentHint: track.contentHint,
      degradationPreference: parameters.degradationPreference,
    };
  } finally {
    diagnosticCamera?.getTracks().forEach((track) => track.stop());
    clearInterval(paintTimer);
    if (playback) {
      playback.pause();
      playback.srcObject = null;
      playback.remove();
    }
    consumer?.close();
    recvTransport?.close();
    audioProducer?.close();
    producer.close();
    secondVideo?.producer.close();
    secondVideo?.transport.close();
    transport.close();
    if (audioTransport !== transport) audioTransport.close();
    // Closing a client transport must also remove the owning socket's SFU transport.
    for (const item of [transport, audioTransport, secondVideo?.transport, recvTransport].filter(Boolean)) {
      let closeError;
      try {
        await rpc('transport:connect', { transportId: item.id, dtlsParameters: {} });
      } catch (error) {
        closeError = error;
      }
      // A cleanup failure makes the browser check invalid, so surface it even if the main run also failed.
      // eslint-disable-next-line no-unsafe-finally
      if (closeError?.message !== 'Transport not found') throw new Error('SFU did not release a closed send transport');
    }
    socket.disconnect();
    if (audioShare) await audioShare.audioGain.context.close();
    await audio.close();
  }
};
