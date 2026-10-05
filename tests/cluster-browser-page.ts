import { Device } from 'mediasoup-client';
import { io } from 'socket.io-client';
import { produceScreenShareVideo } from '/src/screen-share-quality.ts';

window.runClusterCheck = async (keepForRecovery = false) => {
  const sockets = [],
    transports = [],
    videos = [],
    producers = [];
  let paintTimer;
  let retained = false;
  const cleanup = () => {
    clearInterval(paintTimer);
    for (const producer of producers) producer.close();
    for (const video of videos) {
      video.pause();
      video.srcObject = null;
      video.remove();
    }
    for (const item of transports) item.close();
    for (const socket of sockets) socket.disconnect();
  };
  const assert = (value, message) => {
    if (!value) throw new Error(message);
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (check) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await delay(100);
    }
    throw new Error('Cluster condition timed out');
  };
  const diagnostics = (site) => fetch(`/__cluster/${site}/cluster`).then((response) => response.json());
  const connect = async (port) => {
    const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const rpc = (event, payload = {}) =>
      new Promise((resolve, reject) => {
        socket.timeout(18000).emit(event, ...(event === 'room:sync' ? [] : [payload]), (error, result) => {
          if (error || !result?.ok) reject(error || new Error(result?.error));
          else resolve(result);
        });
      });
    return { socket, rpc, device: new Device() };
  };
  const transport = async (peer, direction) => {
    const info = await peer.rpc('transport:create', { direction });
    const result = peer.device[direction === 'send' ? 'createSendTransport' : 'createRecvTransport'](info);
    transports.push(result);
    result.on('connect', ({ dtlsParameters }, ok, fail) =>
      peer.rpc('transport:connect', { transportId: result.id, dtlsParameters }).then(ok, fail),
    );
    result.on('produce', ({ kind, rtpParameters, appData }, ok, fail) =>
      peer.rpc('produce', { transportId: result.id, kind, rtpParameters, appData }).then(({ id }) => ok({ id }), fail),
    );
    return result;
  };
  const consume = async (peer, producerId) => {
    const receiver = await transport(peer, 'recv');
    const info = await peer.rpc('consume', {
      transportId: receiver.id,
      producerId,
      rtpCapabilities: peer.device.recvRtpCapabilities,
    });
    const consumer = await receiver.consume(info);
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = new MediaStream([consumer.track]);
    document.body.append(video);
    videos.push(video);
    await peer.rpc('consumer:resume', { consumerId: consumer.id });
    await video.play();
    await wait(async () =>
      [...(await consumer.getStats()).values()].some((stat) => stat.type === 'inbound-rtp' && stat.framesDecoded > 3),
    );
    return consumer;
  };
  try {
    const sender = await connect(keepForRecovery ? 13020 : 13010);
    const room = await sender.rpc('room:create', { name: 'cluster-source-at-edge' });
    await sender.device.load({ routerRtpCapabilities: room.rtpCapabilities });
    const viewers = await Promise.all([connect(13000), connect(13000), connect(keepForRecovery ? 13010 : 13020)]);
    for (const viewer of viewers) {
      const joined = await viewer.rpc('room:join', { roomId: room.roomId, name: 'cluster-viewer' });
      assert(joined.roomName === room.roomName, 'Master did not preserve room name across sites');
      await viewer.device.load({ routerRtpCapabilities: joined.rtpCapabilities });
    }
    const listed = await (await fetch('/__cluster/a/rooms')).json();
    assert(listed.find((item) => item.id === room.roomId)?.peopleCount === 4, 'Master did not aggregate participants');
    assert((await sender.rpc('room:sync')).peers.length === 3, 'Source cannot discover remote peers');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    let frame = 0;
    paintTimer = setInterval(() => {
      context.fillStyle = `hsl(${frame++ * 7},80%,50%)`;
      context.fillRect(0, 0, 640, 360);
    }, 33);
    const publish = async (peer) => {
      const track = canvas.captureStream(30).getVideoTracks()[0];
      const result = await produceScreenShareVideo(
        () => transport(peer, 'send'),
        track,
        { bitrate: 1_500_000, fps: 30 },
        { label: 'cluster-video' },
        peer.device.sendRtpCapabilities,
      );
      producers.push(result.producer);
      return result.producer;
    };
    const source = await publish(sender);
    await wait(async () =>
      (await viewers[0].rpc('room:sync')).peers.some((peer) => peer.shares.some((share) => share.id === source.id)),
    );
    assert((await diagnostics('b')).outgoing.length === 0, 'Media was exported without any subscribers');
    if (keepForRecovery) {
      const consumer = await consume(viewers[2], source.id);
      viewers[0].socket.disconnect();
      viewers[1].socket.disconnect();
      retained = true;
      window.clusterRecovery = {
        frames: async () =>
          [...(await consumer.getStats()).values()].find((stat) => stat.type === 'inbound-rtp')?.framesDecoded || 0,
        cleanup,
      };
      return { roomId: room.roomId };
    }
    const consumers = await Promise.all(viewers.slice(0, 2).map((viewer) => consume(viewer, source.id)));
    let origin = await diagnostics('b');
    let destination = await diagnostics('a');
    assert(
      origin.outgoing.length === 1 && destination.incoming.length === 1,
      'Two viewers created duplicate WAN streams',
    );
    assert(destination.incoming[0].consumers === 2, 'WAN stream was not shared by both local viewers');
    assert((await diagnostics('c')).incoming.length === 0, 'Unsubscribed site received media');
    assert(origin.outgoing[0].stats[0].rtpBytesSent > 0, 'No RTP passed between sites');
    await Promise.all(consumers.map((consumer, i) => viewers[i].rpc('consumer:pause', { consumerId: consumer.id })));
    assert((await diagnostics('b')).outgoing[0].paused, 'WAN stream continued when every viewer paused');
    await viewers[0].rpc('consumer:resume', { consumerId: consumers[0].id });
    assert(!(await diagnostics('b')).outgoing[0].paused, 'WAN stream did not resume');
    for (let i = 0; i < consumers.length; i++) {
      viewers[i].socket.emit('consumer:close', { consumerId: consumers[i].id });
      consumers[i].close();
    }
    await wait(
      async () => (await diagnostics('b')).outgoing.length === 0 && (await diagnostics('a')).incoming.length === 0,
    );
    await consume(viewers[0], source.id);
    await consume(viewers[2], source.id);
    assert((await diagnostics('b')).outgoing.length === 2, 'Expected one WAN stream per subscribing site');
    const reverse = await publish(viewers[0]);
    await consume(sender, reverse.id);
    assert(
      (await diagnostics('a')).outgoing.length === 1 && (await diagnostics('b')).incoming.length === 1,
      'Reverse direction did not work',
    );
    sender.socket.emit('producer:close', { producerId: source.id });
    source.close();
    await wait(
      async () => (await diagnostics('b')).outgoing.length === 0 && (await diagnostics('c')).incoming.length === 0,
    );
    origin = await diagnostics('b');
    destination = await diagnostics('a');
    assert(
      origin.incoming.length === 1 && destination.outgoing.length === 1,
      'Closing one source interrupted the reverse stream',
    );
    const intruder = await connect(13020);
    const other = await intruder.rpc('room:create', { name: 'other-room' });
    await intruder.device.load({ routerRtpCapabilities: other.rtpCapabilities });
    const receiver = await transport(intruder, 'recv');
    await intruder
      .rpc('consume', {
        transportId: receiver.id,
        producerId: reverse.id,
        rtpCapabilities: intruder.device.recvRtpCapabilities,
      })
      .then(
        () => {
          throw new Error('Cross-room consumption was allowed');
        },
        () => {},
      );
    return { sites: 3, sharedWanStream: true, bidirectionalVideo: true, pauseAndCleanup: true, roomIsolation: true };
  } finally {
    if (!retained) cleanup();
  }
};
