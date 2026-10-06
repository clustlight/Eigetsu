import type { types as Media } from 'mediasoup';

// Probes and room media must use the same addresses, ports and protocol preference.
export function createWebRtcTransport(router: Media.Router, probe = false) {
  const ip = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
  const announcedAddress =
    process.env.MEDIASOUP_ANNOUNCED_IP || (ip === '0.0.0.0' ? '127.0.0.1' : ip === '::' ? '::1' : undefined);
  return router.createWebRtcTransport({
    listenInfos: [
      { protocol: 'udp', ip, announcedAddress },
      { protocol: 'tcp', ip, announcedAddress },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    enableSctp: probe,
    initialAvailableOutgoingBitrate: 30_000_000,
  });
}
