import { Device } from 'mediasoup-client';
import { io, type Socket } from 'socket.io-client';
import { createRpc, check } from './browser-rpc.ts';
import type { BrowserPeer } from './browser-rpc.ts';
import type { Consumer, Transport, ShareAppData } from '../src/types.ts';
import { produceScreenShareAudio, setSharedAudioGain } from '../src/screen-share-audio.ts';
import { configureScreenShareReceiver } from '../src/screen-share-receive.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const runAudioCheck = async (senderPort = 13000, viewerPort = 13000) => {
  const sockets: Socket[] = [];
  const transports: Transport[] = [];
  const context = new AudioContext({ sampleRate: 48_000 });
  let audio: Awaited<ReturnType<typeof produceScreenShareAudio>> | undefined;
  let consumer: Consumer | undefined;
  let sourceTrack: MediaStreamTrack | undefined;
  let playback: HTMLAudioElement | undefined;
  try {
    await context.resume();
    const connect = async (port: number) => {
      const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      const rpc = createRpc(socket, 10000);
      return { socket, rpc };
    };
    const sender = await connect(senderPort);
    const room = await sender.rpc('room:create', { name: 'audio-check' });
    const receiver = await connect(viewerPort);
    await receiver.rpc('room:join', { roomId: room.roomId, name: 'listener' });
    const sendDevice = new Device();
    const recvDevice = new Device();
    await sendDevice.load({ routerRtpCapabilities: room.rtpCapabilities });
    await recvDevice.load({ routerRtpCapabilities: room.rtpCapabilities });
    const createTransport = async (
      client: Pick<BrowserPeer, 'socket' | 'rpc'>,
      device: Device,
      direction: 'send' | 'recv',
    ) => {
      const info = await client.rpc('transport:create', { direction });
      const transport =
        device[direction === 'send' ? 'createSendTransport' : 'createRecvTransport']<ShareAppData>(info);
      transports.push(transport);
      transport.on('connect', ({ dtlsParameters }, ok, fail) => {
        client.rpc('transport:connect', { transportId: transport.id, dtlsParameters }).then(ok, fail);
      });
      transport.on('produce', ({ kind, rtpParameters, appData }, ok, fail) => {
        client
          .rpc('produce', { transportId: transport.id, kind, rtpParameters, appData })
          .then(({ id }) => ok({ id }), fail);
      });
      return transport;
    };

    // Distinct frequencies and levels detect accidental stereo-to-mono conversion.
    const merger = context.createChannelMerger(2);
    for (const [channel, frequency, level] of [
      [0, 997, 0.2],
      [1, 1499, 0.1],
    ]) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      const gain = context.createGain();
      gain.gain.value = level;
      oscillator.connect(gain).connect(merger, 0, channel);
      oscillator.start();
    }
    const destination = context.createMediaStreamDestination();
    merger.connect(destination);
    sourceTrack = destination.stream.getAudioTracks()[0];
    audio = await produceScreenShareAudio(() => createTransport(sender, sendDevice, 'send'), sourceTrack, {});
    const recvTransport = await createTransport(receiver, recvDevice, 'recv');
    const info = await receiver.rpc('consume', {
      transportId: recvTransport.id,
      producerId: audio.producer.id,
      rtpCapabilities: recvDevice.rtpCapabilities,
    });
    consumer = await recvTransport.consume(info);
    configureScreenShareReceiver(consumer);
    // Chromium's WebRTC audio renderer must run to decode the remote stream.
    playback = new Audio();
    playback.srcObject = new MediaStream([consumer.track]);
    playback.volume = 0;
    await playback.play();
    const source = context.createMediaStreamSource(new MediaStream([consumer.track]));
    const splitter = context.createChannelSplitter(2);
    source.connect(splitter);
    const silent = context.createGain();
    silent.gain.value = 0;
    silent.connect(context.destination);
    const analysers = [0, 1].map((channel) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 4096;
      splitter.connect(analyser, channel);
      analyser.connect(silent);
      return analyser;
    });
    await receiver.rpc('consumer:resume', { consumerId: consumer.id });
    await delay(1200);
    const samples = async () => {
      const result = [];
      for (let i = 0; i < 10; i++) {
        await delay(150);
        const channels = analysers.map((analyser) => {
          const data = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(data);
          return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
        });
        result.push(channels);
      }
      return result;
    };
    const full = await samples();
    setSharedAudioGain(audio.audioGain, 0.5);
    await delay(500);
    const half = await samples();
    setSharedAudioGain(audio.audioGain, 0.5, true);
    await delay(500);
    const muted = await samples();
    setSharedAudioGain(audio.audioGain, 0.25, true);
    await delay(300);
    const mutedAfterVolumeChange = await samples();
    setSharedAudioGain(audio.audioGain, 0.25);
    await delay(500);
    const quarter = await samples();
    check(audio.producer.rtpSender && audio.producer.track, 'Audio sender is unavailable');
    const codec = audio.producer.rtpSender.getParameters().codecs.find((codec) => /audio\/opus/i.test(codec.mimeType));
    check(codec?.sdpFmtpLine, 'Opus codec parameters are unavailable');
    const stats = [...(await consumer.getStats()).values()].filter((stat) => stat.type === 'inbound-rtp');
    return {
      full,
      half,
      muted,
      mutedAfterVolumeChange,
      quarter,
      codec,
      captureHint: sourceTrack.contentHint,
      outputHint: audio.producer.track.contentHint,
      sampleRate: audio.audioGain.context.sampleRate,
      debug: {
        contextState: context.state,
        contextTime: context.currentTime,
        outputTime: audio.audioGain.context.currentTime,
        recvState: recvTransport.connectionState,
        sendState: audio.transport.connectionState,
        muted: consumer.track.muted,
        stats,
      },
    };
  } finally {
    if (playback) {
      playback.pause();
      playback.srcObject = null;
    }
    consumer?.close();
    audio?.producer.close();
    transports.forEach((transport) => transport.close());
    sockets.forEach((socket) => socket.disconnect());
    sourceTrack?.stop();
    if (audio) await audio.audioGain.context.close();
    await context.close();
  }
};

window.runAudioCheck = runAudioCheck;
