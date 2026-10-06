import { Device, type types as Media } from 'mediasoup-client';
import { io } from 'socket.io-client';
import type { SfuSite } from './sfu-selection.ts';

export async function probeSfuMedia(site: SfuSite): Promise<number> {
  const socket = io(`${site.url}/probe`, {
    autoConnect: false,
    forceNew: true,
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000,
  });
  let transport: Media.Transport | undefined;
  const deadline = AbortSignal.timeout(8000);
  const close = () => {
    transport?.close();
    socket.disconnect();
  };
  deadline.addEventListener('abort', close, { once: true });
  const rpc = async (event: string, ...args: unknown[]) => {
    const result = await socket.timeout(3000).emitWithAck(event, ...args);
    if (!result?.ok) throw new Error('SFU probe failed');
    return result;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    const info = await rpc('open');
    if (info.siteId !== site.id) throw new Error('SFU probe reached a different site');
    const device = new Device();
    await device.load({ routerRtpCapabilities: info.rtpCapabilities });
    deadline.throwIfAborted();
    transport = device.createSendTransport(info.transport);
    transport.on('connect', ({ dtlsParameters }, ok, fail) => {
      rpc('connect-transport', dtlsParameters).then(() => ok(), fail);
    });
    transport.on('producedata', ({ sctpStreamParameters }, ok, fail) => {
      rpc('produce-data', sctpStreamParameters).then(({ id }) => ok({ id }), fail);
    });
    // A data channel starts ICE/DTLS without requesting a camera or microphone.
    await transport.produceData({ ordered: false, maxRetransmits: 0 });
    while (!deadline.aborted && socket.connected) {
      const stats = await transport.getStats();
      const selected = [...stats.values()].find((stat) => stat.type === 'transport')?.selectedCandidatePairId;
      const pair = selected && stats.get(selected);
      if (transport.connectionState === 'connected' && pair?.currentRoundTripTime != null) {
        const rtt = pair.currentRoundTripTime * 1000;
        if (Number.isFinite(rtt) && rtt >= 0) return rtt;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('SFU media probe timed out');
  } finally {
    deadline.removeEventListener('abort', close);
    close();
  }
}
