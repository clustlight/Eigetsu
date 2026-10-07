import { Device } from 'mediasoup-client';
import { io, type Socket } from 'socket.io-client';
import { createRpc, check } from './browser-rpc.ts';
import type { BrowserPeer } from './browser-rpc.ts';
import type { Transport, ShareAppData, ProducerAnnouncement } from '../src/types.ts';
import { createCompatibleVideoSender } from '../src/compatible-video.ts';
import { produceScreenShareVideo } from '../src/screen-share-quality.ts';

export const runCompatibilityCheck = async (inspectHardware = false, senderPort = 13000, viewerPort = 13000) => {
  const sockets: Socket[] = [];
  const transports: Transport[] = [];
  const playbacks: HTMLVideoElement[] = [];
  let video: Awaited<ReturnType<typeof produceScreenShareVideo>> | undefined;
  let manager: ReturnType<typeof createCompatibleVideoSender> | undefined;
  let camera: MediaStream | undefined;
  let paintTimer: ReturnType<typeof setInterval> | undefined;
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  const waitFor = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Compatibility check timed out');
  };
  const connect = async (port: number) => {
    const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const rpc = createRpc(socket);
    return { socket, rpc, device: new Device() };
  };
  const createTransport = async (peer: BrowserPeer, direction: 'send' | 'recv', producerId?: string) => {
    const info = await peer.rpc('transport:create', {
      direction,
      producerId,
      newShare: direction === 'send' && !producerId,
    });
    const transport =
      peer.device[direction === 'send' ? 'createSendTransport' : 'createRecvTransport']<ShareAppData>(info);
    transports.push(transport);
    transport.observer.once('close', () => peer.socket.emit('transport:close', { transportId: transport.id }));
    transport.on('connect', ({ dtlsParameters }, ok, fail) =>
      peer.rpc('transport:connect', { transportId: transport.id, dtlsParameters }).then(ok, fail),
    );
    transport.on('produce', ({ kind, rtpParameters, appData }, ok, fail) =>
      peer
        .rpc('produce', { transportId: transport.id, kind, rtpParameters, appData })
        .then(({ id }) => ok({ id }), fail),
    );
    return transport;
  };
  const receive = async (
    peer: BrowserPeer,
    info: import('../src/types.ts').RpcResponses['consume'],
    transport: Transport,
  ) => {
    const consumer = await transport.consume(info);
    const element = document.createElement('video');
    element.muted = true;
    element.playsInline = true;
    element.srcObject = new MediaStream([consumer.track]);
    document.body.append(element);
    playbacks.push(element);
    await peer.rpc('consumer:resume', { consumerId: consumer.id });
    await element.play();
    await waitFor(async () =>
      [...(await consumer.getStats()).values()].some((stat) => stat.type === 'inbound-rtp' && stat.framesDecoded > 3),
    );
    return consumer;
  };
  try {
    if (inspectHardware) camera = await navigator.mediaDevices.getUserMedia({ video: true });
    const sender = await connect(senderPort);
    const room = await sender.rpc('room:create', { name: 'compatibility-check' });
    sender.device = new Device();
    await sender.device.load({ routerRtpCapabilities: room.rtpCapabilities });
    const viewer = await connect(viewerPort);
    await viewer.rpc('room:join', { roomId: room.roomId, name: 'baseline-viewer' });
    // Emulate the negotiated intersection for an iOS receiver that advertises
    // 42e0 / 640c, while this router publishes 42e0 / 4d00 / 6400.
    const codecs = (room.rtpCapabilities.codecs || []).filter(
      (codec) =>
        codec.mimeType.toLowerCase() === 'video/h264' &&
        /^42e0/i.test(String(codec.parameters?.['profile-level-id'] || '')),
    );
    const payloads = new Set(codecs.map((codec) => codec.preferredPayloadType));
    viewer.device = new Device();
    await viewer.device.load({
      routerRtpCapabilities: {
        ...room.rtpCapabilities,
        codecs: [
          ...codecs,
          ...(room.rtpCapabilities.codecs || []).filter(
            (codec) => codec.mimeType.toLowerCase() === 'video/rtx' && payloads.has(Number(codec.parameters?.apt)),
          ),
        ],
      },
    });
    let compatibilityRequests = 0,
      compatibilityActive = false;
    const announced: ProducerAnnouncement[] = [];
    viewer.socket.on('producer:new', (data) => announced.push(data));
    manager = createCompatibleVideoSender({
      getProducer: (id) => (video?.producer.id === id ? video.producer : undefined),
      createTransport: (producerId) => createTransport(sender, 'send', producerId),
      capabilities: sender.device.sendRtpCapabilities,
      onStatus: (_id, active) => {
        compatibilityActive = active;
      },
    });
    sender.socket.on('producer:compatibility-request', (request, reply) => {
      compatibilityRequests++;
      manager?.request(request, reply);
    });
    sender.socket.on('producer:compatibility-stop', ({ producerId }) => manager?.stop(producerId));
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const paint = canvas.getContext('2d');
    check(paint, 'Canvas 2D is unavailable');
    let frame = 0;
    paintTimer = setInterval(() => {
      paint.fillStyle = `hsl(${frame++ * 4},80%,50%)`;
      paint.fillRect(0, 0, canvas.width, canvas.height);
    }, 33);
    const track = canvas.captureStream(30).getVideoTracks()[0];
    video = await produceScreenShareVideo(
      () => createTransport(sender, 'send'),
      track,
      { id: 'compatibility', label: 'Compatibility', width: 1920, height: 1080, bitrate: 8_000_000, fps: 30 },
      { compatibilitySupported: true, profile: '1080p30' },
      sender.device.sendRtpCapabilities,
    );
    assert(
      /^4d00/i.test(String(video.producer.rtpParameters.codecs[0].parameters?.['profile-level-id'] || '')),
      'Test requires a Main-profile primary stream',
    );
    const normalTransport = await createTransport(sender, 'recv', video.producer.id);
    const normalInfo = await sender.rpc('consume', {
      transportId: normalTransport.id,
      producerId: video.producer.id,
      rtpCapabilities: sender.device.recvRtpCapabilities,
    });
    await receive(sender, normalInfo, normalTransport);
    assert(
      normalInfo.producerId === video.producer.id && compatibilityRequests === 0,
      'Compatible viewers must use the primary stream',
    );
    const receiveTransports = await Promise.all([
      createTransport(viewer, 'recv', video.producer.id),
      createTransport(viewer, 'recv', video.producer.id),
    ]);
    const infos = await Promise.all(
      receiveTransports.map((transport) =>
        viewer.rpc('consume', {
          transportId: transport.id,
          producerId: video!.producer.id,
          rtpCapabilities: viewer.device.recvRtpCapabilities,
        }),
      ),
    );
    assert(compatibilityRequests === 1, 'Concurrent viewers created duplicate compatibility encoders');
    assert(
      infos[0].producerId !== video.producer.id && infos[0].producerId === infos[1].producerId,
      'Viewers must share one compatible producer',
    );
    assert(
      /^42e0/i.test(String(infos[0].rtpParameters.codecs[0].parameters?.['profile-level-id'] || '')),
      'Fallback must actually negotiate Constrained Baseline',
    );
    const consumers = await Promise.all(infos.map((info, index) => receive(viewer, info, receiveTransports[index])));
    assert(
      playbacks.slice(1).every((element) => element.videoWidth <= 1920 && element.videoHeight <= 1080),
      'Compatibility resolution exceeded its budget',
    );
    const synced = await viewer.rpc('room:sync');
    assert(
      synced.peers[0].shares.length === 1 && announced.length === 1,
      'Compatibility video must not appear as a separate screen card',
    );
    const primaryStats = [...(await video.producer.getStats()).values()].find(
      (stat) => stat.type === 'outbound-rtp' && stat.kind === 'video',
    );
    const primaryEncoder = primaryStats.encoderImplementation || 'unavailable';
    const primaryPowerEfficient = primaryStats.powerEfficientEncoder;
    for (const consumer of consumers) {
      viewer.socket.emit('consumer:close', { consumerId: consumer.id });
      consumer.close();
    }
    await waitFor(() => !compatibilityActive);
    assert(track.readyState === 'live' && !video.producer.closed, 'Stopping the fallback stopped the primary capture');
    const again = await viewer.rpc('consume', {
      transportId: receiveTransports[0].id,
      producerId: video.producer.id,
      rtpCapabilities: viewer.device.recvRtpCapabilities,
    });
    assert(
      compatibilityRequests === 2 && again.producerId !== infos[0].producerId,
      'Returning viewer must recreate the idle fallback',
    );
    const closed = new Promise<{ producerId: string }>((resolve) => viewer.socket.once('producer:closed', resolve));
    sender.socket.emit('producer:close', { producerId: video.producer.id });
    video.producer.close();
    const event = await closed;
    assert(event.producerId === video.producer.id, 'Closure must use the logical screen ID');
    await waitFor(() => !compatibilityActive);
    return {
      primaryEncoder,
      primaryPowerEfficient,
      compatibilityRequests,
      decodedViewers: consumers.length,
      profile: '42e0',
      maxSize: '1920x1080',
      cleanup: true,
    };
  } finally {
    manager?.close();
    video?.producer.close();
    clearInterval(paintTimer);
    for (const element of playbacks) {
      element.pause();
      element.srcObject = null;
      element.remove();
    }
    for (const transport of transports) transport.close();
    for (const socket of sockets) socket.disconnect();
    camera?.getTracks().forEach((track) => track.stop());
  }
};

window.runCompatibilityCheck = runCompatibilityCheck;
