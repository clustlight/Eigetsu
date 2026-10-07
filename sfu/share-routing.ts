import { randomUUID } from 'node:crypto';
import type { types as Media } from 'mediasoup';
import type { Producer } from './types.js';

/** Counts screen groups across rooms, including allocations still being created. */
export class ShareWorkerPool {
  private loads = new Map<Media.Worker, number>();

  constructor(workers: Media.Worker[], codecs: Media.RouterRtpCodecCapability[]) {
    this.workers = workers;
    this.codecs = codecs;
  }
  private workers: Media.Worker[];
  private codecs: Media.RouterRtpCodecCapability[];

  async createRouter() {
    const worker = this.workers
      .filter((worker) => !worker.closed)
      .reduce<Media.Worker | undefined>(
        (best, worker) => (!best || (this.loads.get(worker) || 0) < (this.loads.get(best) || 0) ? worker : best),
        undefined,
      );
    if (!worker) throw new Error('No media workers available');
    this.loads.set(worker, (this.loads.get(worker) || 0) + 1);
    const release = () => this.loads.set(worker, this.loads.get(worker)! - 1);
    try {
      const router = await worker.createRouter({ mediaCodecs: this.codecs });
      router.appData.workerPid = worker.pid;
      router.observer.once('close', release);
      return router;
    } catch (error) {
      release();
      throw error;
    }
  }
}

interface Group {
  router: Promise<Media.Router>;
  reservations: number;
  transports: Set<Media.Transport>;
}

/** A screen, its audio and compatibility video share one router on each site. */
export class ShareRouting {
  private pool: ShareWorkerPool;
  private groups = new Map<string, Group>();
  private producers = new Map<string, Media.Router>();
  private transports = new Map<string, Media.Router>();
  private routerKeys = new WeakMap<Media.Router, string>();
  private closed = false;

  constructor(pool: ShareWorkerPool) {
    this.pool = pool;
  }

  producerRouter(id: string) {
    return this.producers.get(id);
  }

  transportRouter(id: string) {
    return this.transports.get(id);
  }

  registerProducer(producer: Producer, router: Media.Router) {
    this.producers.set(producer.id, router);
    producer.observer.once('close', () => this.producers.delete(producer.id));
  }

  async createTransport<T extends Media.Transport>(
    target: Media.Router | string | undefined,
    create: (router: Media.Router) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error('Room closed');
    if (target && typeof target !== 'string') {
      const existingKey = this.routerKeys.get(target);
      if (existingKey) {
        if (target.closed || !this.groups.has(existingKey)) throw new Error('Share closed');
        return this.createTransport(existingKey, create);
      }
    }
    const key = typeof target === 'string' ? target : randomUUID();
    let group: Group | undefined;
    if (!target || typeof target === 'string') {
      group = this.groups.get(key);
      if (!group) {
        const created: Group = { router: this.pool.createRouter(), reservations: 0, transports: new Set() };
        group = created;
        this.groups.set(key, group);
        void created.router
          .then((router) => {
            this.routerKeys.set(router, key);
            if (this.closed) {
              router.close();
              return;
            }
            router.observer.on('newtransport', (transport) => {
              created.transports.add(transport);
              transport.observer.once('close', () => {
                created.transports.delete(transport);
                this.cleanup(key, created, router);
              });
            });
          })
          .catch(() => {});
      }
      group.reservations++;
    }
    let router: Media.Router | undefined;
    try {
      router = group ? await group.router : (target as Media.Router);
      if (this.closed || router.closed) throw new Error('Room closed');
      const transport = await create(router);
      if (this.closed || router.closed) {
        transport.close();
        throw new Error('Room closed');
      }
      this.transports.set(transport.id, router);
      transport.observer.once('close', () => this.transports.delete(transport.id));
      return transport;
    } finally {
      if (group) {
        group.reservations--;
        if (router) this.cleanup(key, group, router);
        else if (this.groups.get(key) === group) this.groups.delete(key);
      }
    }
  }

  private cleanup(key: string, group: Group, router: Media.Router) {
    if (group.reservations || group.transports.size) return;
    if (this.groups.get(key) === group) this.groups.delete(key);
    router.close();
  }

  close() {
    this.closed = true;
    for (const group of this.groups.values()) void group.router.then((router) => router.close()).catch(() => {});
    this.groups.clear();
  }
}
