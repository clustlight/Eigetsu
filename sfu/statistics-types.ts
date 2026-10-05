export interface TrafficStats {
  transports: number;
  receiveBps: number;
  sendBps: number;
  bytesReceived: number;
  bytesSent: number;
  unavailable: number;
}

export interface SfuStatistics {
  sampledAt: number;
  role: 'standalone' | 'master' | 'sfu';
  uptimeSeconds: number;
  rooms: number;
  peers: number;
  producers: number;
  nodeRssBytes: number;
  workers: { pid: number; cpuPercent: number | null; maxRssBytes: number }[];
  workerErrors: number;
  clients: TrafficStats;
  pipes: TrafficStats;
  incomingPipes: number;
  outgoingPipes: number;
}

export interface ClusterStatistics {
  sampledAt: number;
  rooms: number;
  peers: number;
  sites: {
    id: string;
    url: string;
    status: 'online' | 'offline' | 'unavailable';
    metrics: SfuStatistics | null;
  }[];
}
