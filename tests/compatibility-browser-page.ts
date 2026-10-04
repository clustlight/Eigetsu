import { Device } from 'mediasoup-client';
import { io } from 'socket.io-client';
import { createCompatibleVideoSender } from '/src/compatible-video.ts';
import { produceScreenShareVideo } from '/src/screen-share-quality.ts';

window.runCompatibilityCheck = async (inspectHardware = false) => {
  const sockets = [],
    transports = [],
    playbacks = [];
  let video, manager, camera, paintTimer;
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const waitFor = async (check) => {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Compatibility check timed out');
  };
  const connect = async () => {
    const socket = io('http://127.0.0.1:13000', { transports: ['websocket'] });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const rpc = (event, payload = {}) =>
      new Promise((resolve, reject) =>
        socket
          .timeout(15000)
          .emit(event, ...(event === 'room:sync' ? [] : [payload]), (error, response) =>
            error
              ? reject(new Error(`${event}: ${error.message}`))
              : response.ok
                ? resolve(response)
                : reject(new Error(`${event}: ${response.error}`)),
          ),
      );
    return { socket, rpc };
  };
  const createTransport = async (peer, direction) => {
    const info = await peer.rpc('transport:create', { direction });
    const transport = peer.device[direction === 'send' ? 'createSendTransport' : 'createRecvTransport'](info);
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
  const receive = async (peer, info, transport) => {
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
    const sender = await connect();
    const room = await sender.rpc('room:create', { name: 'compatibility-check' });
    sender.device = new Device();
    await sender.device.load({ routerRtpCapabilities: room.rtpCapabilities });
    const viewer = await connect();
    await viewer.rpc('room:join', { roomId: room.roomId, name: 'baseline-viewer' });
    // Emulate the negotiated intersection for an iOS receiver that advertises
    // 42e0 / 640c, while this router publishes 42e0 / 4d00 / 6400.
    const codecs = room.rtpCapabilities.codecs.filter(
      (codec) =>
        codec.mimeType.toLowerCase() === 'video/h264' && /^42e0/i.test(codec.parameters?.['profile-level-id'] || ''),
    );
    const payloads = new Set(codecs.map((codec) => codec.preferredPayloadType));
    viewer.device = new Device();
    await viewer.device.load({
      routerRtpCapabilities: {
        ...room.rtpCapabilities,
        codecs: [
          ...codecs,
          ...room.rtpCapabilities.codecs.filter(
            (codec) => codec.mimeType.toLowerCase() === 'video/rtx' && payloads.has(codec.parameters.apt),
          ),
        ],
      },
    });
    let compatibilityRequests = 0,
      compatibilityActive = false;
    const announced = [];
    viewer.socket.on('producer:new', (data) => announced.push(data));
    manager = createCompatibleVideoSender({
      getProducer: (id) => (video?.producer.id === id ? video.producer : undefined),
      createTransport: () => createTransport(sender, 'send'),
      capabilities: sender.device.sendRtpCapabilities,
      onStatus: (_id, active) => {
        compatibilityActive = active;
      },
    });
    sender.socket.on('producer:compatibility-request', (request, reply) => {
      compatibilityRequests++;
      manager.request(request, reply);
    });
    sender.socket.on('producer:compatibility-stop', ({ producerId }) => manager.stop(producerId));
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const paint = canvas.getContext('2d');
    let frame = 0;
    paintTimer = setInterval(() => {
      paint.fillStyle = `hsl(${frame++ * 4},80%,50%)`;
      paint.fillRect(0, 0, canvas.width, canvas.height);
    }, 33);
    const track = canvas.captureStream(30).getVideoTracks()[0];
    video = await produceScreenShareVideo(
      () => createTransport(sender, 'send'),
      track,
      { bitrate: 8_000_000, fps: 30 },
      { compatibilitySupported: true, profile: '1080p30' },
      sender.device.sendRtpCapabilities,
    );
    assert(
      /^4d00/i.test(video.producer.rtpParameters.codecs[0].parameters['profile-level-id']),
      'Test requires a Main-profile primary stream',
    );
    const normalTransport = await createTransport(sender, 'recv');
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
    const receiveTransports = await Promise.all([createTransport(viewer, 'recv'), createTransport(viewer, 'recv')]);
    const infos = await Promise.all(
      receiveTransports.map((transport) =>
        viewer.rpc('consume', {
          transportId: transport.id,
          producerId: video.producer.id,
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
      /^42e0/i.test(infos[0].rtpParameters.codecs[0].parameters['profile-level-id']),
      'Fallback must actually negotiate Constrained Baseline',
    );
    const consumers = await Promise.all(infos.map((info, index) => receive(viewer, info, receiveTransports[index])));
    assert(
      playbacks.slice(1).every((element) => element.videoWidth <= 1280 && element.videoHeight <= 720),
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
    const closed = new Promise((resolve) => viewer.socket.once('producer:closed', resolve));
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
