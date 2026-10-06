import type { Server } from 'socket.io';
import type { types as Media } from 'mediasoup';
import { createWebRtcTransport } from './webrtc-transport.ts';

/** Short-lived ICE measurements, without joining or creating a room. */
export function installSfuProbe(io: Server, worker: Media.Worker, siteId: string, ready: () => boolean) {
  let router: Promise<Media.Router> | undefined;
  let active = 0;
  const namespace = io.of('/probe');
  namespace.use((_socket, next) => next(ready() && active < 64 ? undefined : new Error('Probe unavailable')));
  namespace.on('connection', (socket) => {
    active++;
    let transport: Media.WebRtcTransport | undefined;
    let opened = false;
    let produced = false;
    const timer = setTimeout(() => socket.disconnect(true), 10000);
    timer.unref();
    socket.once('disconnect', () => {
      active--;
      clearTimeout(timer);
      transport?.close();
    });
    socket.on('open', async (reply) => {
      if (typeof reply !== 'function') return;
      try {
        if (opened || !ready()) throw new Error('Probe unavailable');
        opened = true;
        router ??= worker.createRouter({ mediaCodecs: [] }).catch((error) => {
          router = undefined;
          throw error;
        });
        const selected = await router;
        transport = await createWebRtcTransport(selected, true);
        if (!socket.connected) {
          transport.close();
          return;
        }
        reply({
          ok: true,
          siteId,
          rtpCapabilities: selected.rtpCapabilities,
          transport: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            sctpParameters: transport.sctpParameters,
          },
        });
      } catch {
        reply({ ok: false });
      }
    });
    socket.on('connect-transport', async (dtlsParameters: Media.DtlsParameters, reply) => {
      if (typeof reply !== 'function') return;
      try {
        if (!transport) throw new Error('Probe not opened');
        await transport.connect({ dtlsParameters });
        reply({ ok: true });
      } catch {
        reply({ ok: false });
      }
    });
    socket.on('produce-data', async (sctpStreamParameters: Media.SctpStreamParameters, reply) => {
      if (typeof reply !== 'function') return;
      try {
        if (!transport || produced) throw new Error('Probe unavailable');
        produced = true;
        const producer = await transport.produceData({ sctpStreamParameters });
        reply({ ok: true, id: producer.id });
      } catch {
        reply({ ok: false });
      }
    });
  });
}
