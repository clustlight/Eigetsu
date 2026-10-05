import type { types as Media } from 'mediasoup';
import type { Room } from './types.js';
import type { Federation } from './federation.ts';
import type { SfuStatistics, TrafficStats } from './statistics-types.js';

export function summarizeTraffic(
  samples: { recvBitrate: number; sendBitrate: number; bytesReceived: number; bytesSent: number }[][],
): TrafficStats {
  return {
    transports: samples.length,
    unavailable: samples.filter((sample) => !sample.length).length,
    receiveBps: samples.flat().reduce((sum, stat) => sum + stat.recvBitrate, 0),
    sendBps: samples.flat().reduce((sum, stat) => sum + stat.sendBitrate, 0),
    bytesReceived: samples.flat().reduce((sum, stat) => sum + stat.bytesReceived, 0),
    bytesSent: samples.flat().reduce((sum, stat) => sum + stat.bytesSent, 0),
  };
}

export function createStatisticsCollector(
  role: SfuStatistics['role'],
  rooms: Map<string, Room>,
  workers: Media.Worker[],
  transports: Set<Media.WebRtcTransport>,
  federation: Federation,
) {
  const previous = new Map<number, { time: number; cpu: number }>();
  let cached: SfuStatistics | undefined;
  let pending: Promise<SfuStatistics> | undefined;
  const collect = async (): Promise<SfuStatistics> => {
    const [usage, clients, pipes] = await Promise.all([
      Promise.all(
        workers.map(async (worker) => {
          try {
            const resource = await worker.getResourceUsage();
            const time = performance.now();
            const cpu = resource.ru_utime + resource.ru_stime;
            const last = previous.get(worker.pid);
            previous.set(worker.pid, { time, cpu });
            return {
              pid: worker.pid,
              cpuPercent: last ? Math.max(0, ((cpu - last.cpu) / (time - last.time)) * 100) : null,
              maxRssBytes: resource.ru_maxrss * 1024,
            };
          } catch {
            return null;
          }
        }),
      ),
      Promise.all([...transports].map((transport) => transport.getStats().catch(() => []))),
      federation.diagnostics(),
    ]);
    const localRooms = [...rooms.values()];
    return {
      sampledAt: Date.now(),
      role,
      uptimeSeconds: process.uptime(),
      rooms: localRooms.filter((room) => room.peers.size > 0).length,
      peers: localRooms.reduce((sum, room) => sum + room.peers.size, 0),
      producers: localRooms.reduce(
        (sum, room) => sum + [...room.peers.values()].reduce((n, peer) => n + peer.producers.size, 0),
        0,
      ),
      nodeRssBytes: process.memoryUsage().rss,
      workers: usage.filter((value) => value !== null),
      workerErrors: usage.filter((value) => value === null).length,
      clients: summarizeTraffic(clients),
      pipes: summarizeTraffic([...pipes.incoming, ...pipes.outgoing].map((pipe) => pipe.stats)),
      incomingPipes: pipes.incoming.length,
      outgoingPipes: pipes.outgoing.length,
    };
  };
  return () => {
    if (cached && Date.now() - cached.sampledAt < 4000) return Promise.resolve(cached);
    return (pending ??= collect()
      .then((result) => (cached = result))
      .finally(() => {
        pending = undefined;
      }));
  };
}
