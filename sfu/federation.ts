import { randomUUID } from 'node:crypto';
import type { types as Media } from 'mediasoup';
import type { ClusterClient } from './cluster-client.js';
import type { PipeCommand, PipeDescription, Site } from './cluster-types.js';
import type { Producer, Room, ShareAppData } from './types.js';

interface Incoming {
  key: string;
  roomId: string;
  originalId: string;
  linkId: string;
  siteId: string;
  transport: Media.PipeTransport;
  producer: Producer;
  consumers: Set<Media.Consumer>;
  reservations: number;
  closed: boolean;
  updates: Promise<void>;
}
interface Outgoing {
  roomId: string;
  siteId: string;
  transport: Media.PipeTransport;
  consumer: Media.Consumer;
  source: Producer;
  touched: number;
}
export interface ProducerLease {
  producer: Producer;
  attach(consumer: Media.Consumer): void;
  release(): void;
}

/** One encrypted UDP pipe per producer variant and receiving site, shared by all local viewers. */
export class Federation {
  onRetry: (roomId: string, producerId: string) => void = () => {};
  private incoming = new Map<string, Incoming>();
  private retries = new Map<string, { roomId: string; producerId: string }>();
  private pending = new Map<string, Promise<Incoming>>();
  private outgoing = new Map<string, Outgoing>();
  private cluster: ClusterClient;
  private rooms: Map<string, Room>;
  private listenIp: string;
  private resolveLocal: (room: Room, producerId: string, capabilities: Media.RtpCapabilities) => Promise<Producer>;

  constructor(options: {
    cluster: ClusterClient;
    rooms: Map<string, Room>;
    listenIp: string;
    resolveLocal: (room: Room, producerId: string, capabilities: Media.RtpCapabilities) => Promise<Producer>;
  }) {
    this.cluster = options.cluster;
    this.rooms = options.rooms;
    this.listenIp = options.listenIp;
    this.resolveLocal = options.resolveLocal;
    this.cluster.onOperation = (from, command) => this.handle(from, command);
    this.cluster.onOffline = (siteId) => this.closeSite(siteId);
    this.cluster.onReady = () => {
      for (const entry of this.incoming.values()) void this.update(entry).catch(() => {});
      for (const entry of this.outgoing.values()) entry.touched = Date.now();
      this.retrySubscriptions();
    };
    const timer = setInterval(() => {
      if (!this.cluster.ready) return;
      for (const entry of this.incoming.values()) void this.update(entry).catch(() => {});
      for (const entry of this.outgoing.values()) if (Date.now() - entry.touched > 45000) entry.transport.close();
      this.retrySubscriptions();
    }, 10000);
    timer.unref();
  }

  private async transport(router: Media.Router) {
    return router.createPipeTransport({
      listenInfo: { protocol: 'udp', ip: this.listenIp, announcedAddress: this.cluster.site.pipeAddress },
      enableRtx: true,
      enableSrtp: true,
    });
  }

  async acquire(
    room: Room,
    originalId: string,
    capabilities: Media.RtpCapabilities,
    router = room.router,
  ): Promise<ProducerLease> {
    const owner = this.cluster.rooms
      .get(room.id)
      ?.peers.find((peer) => peer.shares.some((share) => share.id === originalId));
    if (!owner || owner.siteId === this.cluster.site.id) throw new Error('配信元が見つかりません');
    const resolved = await this.cluster.relay<{ producerId: string }>(owner.siteId, {
      action: 'resolve',
      roomId: room.id,
      producerId: originalId,
      rtpCapabilities: capabilities,
    });
    const key = `${room.id}/${router.id}/${resolved.producerId}`;
    let entry = this.incoming.get(key);
    if (!entry || entry.closed) {
      let pending = this.pending.get(key);
      if (!pending) {
        pending = this.openIncoming(room, router, owner.siteId, originalId, resolved.producerId, key).finally(() =>
          this.pending.delete(key),
        );
        this.pending.set(key, pending);
      }
      entry = await pending;
    }
    if (entry.closed || router.closed) throw new Error('共有が終了しています');
    this.retries.delete(`${room.id}/${originalId}`);
    entry.reservations++;
    const selected = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      selected.reservations--;
      this.cleanup(selected);
    };
    return {
      producer: entry.producer,
      release,
      attach: (consumer) => {
        if (released || selected.closed) throw new Error('共有が終了しています');
        selected.consumers.add(consumer);
        consumer.observer.on('pause', () => {
          void this.update(selected).catch(() => {});
        });
        consumer.observer.on('resume', () => {
          void this.update(selected).catch(() => {});
        });
        consumer.observer.once('close', () => {
          selected.consumers.delete(consumer);
          this.cleanup(selected);
        });
        release();
        void this.update(selected).catch(() => {});
      },
    };
  }

  private async openIncoming(
    room: Room,
    router: Media.Router,
    siteId: string,
    originalId: string,
    producerId: string,
    key: string,
  ): Promise<Incoming> {
    const linkId = randomUUID();
    const transport = await this.transport(router);
    try {
      const description = await this.cluster.relay<PipeDescription & { address: string }>(siteId, {
        action: 'open',
        roomId: room.id,
        producerId,
        linkId,
        endpoint: { port: transport.tuple.localPort, srtpParameters: transport.srtpParameters! },
      });
      if (transport.closed || router.closed) throw new Error('Room closed while connecting sites');
      await transport.connect({
        ip: description.address,
        port: description.port,
        srtpParameters: description.srtpParameters,
      });
      const producer = await transport.produce<ShareAppData>({
        id: description.producerId,
        kind: description.kind,
        rtpParameters: description.rtpParameters,
        appData: description.appData,
      });
      const entry: Incoming = {
        key,
        roomId: room.id,
        originalId,
        linkId,
        siteId,
        transport,
        producer,
        consumers: new Set(),
        reservations: 0,
        closed: false,
        updates: Promise.resolve(),
      };
      this.incoming.set(key, entry);
      transport.observer.once('close', () => this.closeIncoming(entry, true));
      producer.observer.once('close', () => this.closeIncoming(entry, true));
      // Establish the lease even while the browser is negotiating its consumer.
      await this.update(entry);
      return entry;
    } catch (error) {
      transport.close();
      void this.cluster.relay(siteId, { action: 'release', roomId: room.id, linkId }).catch(() => {});
      throw error;
    }
  }

  private cleanup(entry: Incoming) {
    if (!entry.reservations && !entry.consumers.size) this.closeIncoming(entry);
    else void this.update(entry).catch(() => {});
  }

  private closeIncoming(entry: Incoming, retry = false) {
    if (entry.closed) return;
    entry.closed = true;
    if (retry && entry.consumers.size) {
      this.retries.set(`${entry.roomId}/${entry.originalId}`, { roomId: entry.roomId, producerId: entry.originalId });
      setTimeout(() => this.retrySubscriptions(), 250).unref();
    }
    if (this.incoming.get(entry.key) === entry) this.incoming.delete(entry.key);
    entry.transport.close();
    void this.cluster
      .relay(entry.siteId, { action: 'release', roomId: entry.roomId, linkId: entry.linkId })
      .catch(() => {});
  }

  private update(entry: Incoming): Promise<void> {
    entry.updates = entry.updates
      .catch(() => {})
      .then(async () => {
        if (entry.closed) return;
        try {
          await this.cluster.relay(entry.siteId, {
            action: 'active',
            roomId: entry.roomId,
            linkId: entry.linkId,
            active: [...entry.consumers].some((consumer) => !consumer.closed && !consumer.paused),
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'Inter-site stream no longer exists')
            this.closeIncoming(entry, true);
          throw error;
        }
      });
    return entry.updates;
  }

  async synchronizeConsumer(consumer: Media.Consumer) {
    const entry = [...this.incoming.values()].find((entry) => entry.consumers.has(consumer));
    // Local pause/resume remains usable during a coordinator outage. The lease
    // renewal/onReady path reapplies the aggregate demand after reconnection.
    if (entry && this.cluster.ready) await this.update(entry).catch(() => {});
  }

  reconcile(roomId: string, producerIds: Set<string>) {
    for (const entry of this.incoming.values())
      if (entry.roomId === roomId && !producerIds.has(entry.originalId)) this.closeIncoming(entry);
    for (const [key, retry] of this.retries)
      if (retry.roomId === roomId && !producerIds.has(retry.producerId)) this.retries.delete(key);
  }

  private retrySubscriptions() {
    if (!this.cluster.ready) return;
    for (const [key, retry] of this.retries) {
      if (
        !this.rooms.get(retry.roomId)?.peers.size ||
        !this.cluster.rooms
          .get(retry.roomId)
          ?.peers.some((peer) => peer.shares.some((share) => share.id === retry.producerId))
      ) {
        this.retries.delete(key);
        continue;
      }
      this.onRetry(retry.roomId, retry.producerId);
    }
  }

  private closeSite(siteId: string) {
    for (const entry of this.incoming.values()) if (entry.siteId === siteId) this.closeIncoming(entry);
    for (const entry of this.outgoing.values()) if (entry.siteId === siteId) entry.transport.close();
  }

  private async handle(from: Site, command: PipeCommand): Promise<unknown> {
    if (command.action === 'closed') {
      const entry = [...this.incoming.values()].find(
        (entry) => entry.linkId === command.linkId && entry.siteId === from.id && entry.roomId === command.roomId,
      );
      if (entry) this.closeIncoming(entry, true);
      return;
    }
    if (command.action === 'release' || command.action === 'active') {
      const entry = this.outgoing.get(command.linkId);
      if (!entry || entry.siteId !== from.id || entry.roomId !== command.roomId) {
        if (command.action === 'release') return;
        throw new Error('Inter-site stream no longer exists');
      }
      entry.touched = Date.now();
      if (command.action === 'release') entry.transport.close();
      else if (command.active) await entry.consumer.resume();
      else await entry.consumer.pause();
      return;
    }
    const room = this.rooms.get(command.roomId);
    if (!room || room.router.closed) throw new Error('Room not available on origin SFU');
    if (command.action === 'resolve') {
      const source = await this.resolveLocal(room, command.producerId, command.rtpCapabilities);
      return { producerId: source.id };
    }
    if (command.action !== 'open') throw new Error('Unknown pipe operation');
    const source = [...room.peers.values()]
      .map((peer) => peer.producers.get(command.producerId))
      .find((producer) => producer && !producer.closed);
    if (!source) throw new Error('共有が終了しています');
    if (this.outgoing.has(command.linkId)) throw new Error('Duplicate pipe identifier');
    const transport = await this.transport(room.routing.producerRouter(source.id) || room.router);
    try {
      // Use the address registered by the authenticated destination SFU, never a browser supplied address.
      await transport.connect({
        ip: from.pipeAddress,
        port: command.endpoint.port,
        srtpParameters: command.endpoint.srtpParameters,
      });
      const consumer = await transport.consume({ producerId: source.id });
      await consumer.pause();
      const entry: Outgoing = { roomId: room.id, siteId: from.id, transport, consumer, source, touched: Date.now() };
      this.outgoing.set(command.linkId, entry);
      const compatibility = source.appData.compatibilityFor
        ? room.compatibilityStreams.get(source.appData.compatibilityFor)
        : undefined;
      if (compatibility) {
        if (compatibility.timer) clearTimeout(compatibility.timer);
        compatibility.consumers.add(consumer.id);
        consumer.observer.once('close', () => {
          compatibility.consumers.delete(consumer.id);
          if (!source.closed) compatibility.scheduleClose();
        });
      }
      consumer.on('producerclose', () => transport.close());
      transport.observer.once('close', () => {
        this.outgoing.delete(command.linkId);
        void this.cluster.relay(from.id, { action: 'closed', roomId: room.id, linkId: command.linkId }).catch(() => {});
      });
      if (source.closed) throw new Error('共有が終了しています');
      return {
        producerId: source.id,
        kind: source.kind,
        appData: source.appData,
        rtpParameters: consumer.rtpParameters,
        address: this.cluster.site.pipeAddress,
        port: transport.tuple.localPort,
        srtpParameters: transport.srtpParameters!,
      } satisfies PipeDescription & { address: string };
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  async diagnostics() {
    return {
      incoming: await Promise.all(
        [...this.incoming.values()].map(async (entry) => ({
          roomId: entry.roomId,
          siteId: entry.siteId,
          producerId: entry.producer.id,
          consumers: entry.consumers.size,
          stats: await entry.transport.getStats().catch(() => []),
        })),
      ),
      outgoing: await Promise.all(
        [...this.outgoing.values()].map(async (entry) => ({
          roomId: entry.roomId,
          siteId: entry.siteId,
          producerId: entry.source.id,
          paused: entry.consumer.paused,
          stats: await entry.transport.getStats().catch(() => []),
        })),
      ),
    };
  }
}
