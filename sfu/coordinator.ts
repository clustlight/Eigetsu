import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import type { Server, Socket } from 'socket.io';
import type { ClusterPeer, ControlReply, ControlRequest, RoomSnapshot, Site } from './cluster-types.js';
import { validateOrigin } from './cluster-config.ts';
import type { ClusterStatistics, SfuStatistics } from './statistics-types.js';

const RETENTION_MS = 5 * 60_000;
interface RegisteredSite {
  site: Site;
  socket: Socket;
  registered: boolean;
  expiry?: ReturnType<typeof setTimeout>;
}

/** Authoritative room metadata. Media never passes through this coordinator. */
export class Coordinator {
  readonly rooms = new Map<string, RoomSnapshot>();
  private sites = new Map<string, RegisteredSite>();
  private knownSites = new Map<string, Site>();
  private stateFile: string;
  private statisticsCache?: ClusterStatistics;
  private statisticsPending?: Promise<ClusterStatistics>;

  constructor(io: Server, secret: string, stateFile: string, siteGraceMs: number) {
    this.stateFile = stateFile;
    if (stateFile && existsSync(stateFile)) {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as {
        version: number;
        rooms: RoomSnapshot[];
        sites: Site[];
      };
      if (saved.version !== 1 || !Array.isArray(saved.rooms) || !Array.isArray(saved.sites))
        throw new Error('Invalid master state file');
      for (const room of saved.rooms) {
        if (typeof room.id !== 'string' || typeof room.name !== 'string') throw new Error('Invalid master state file');
        this.rooms.set(room.id, room);
      }
      for (const site of saved.sites) this.knownSites.set(site.id, site);
    }
    this.save();
    const namespace = io.of('/cluster');
    // Preserve live edge sessions over a coordinator restart. Sites must confirm
    // their persisted metadata during this grace period; stale participants expire.
    const recovery = setTimeout(() => {
      for (const siteId of this.knownSites.keys()) {
        if (this.sites.get(siteId)?.registered) continue;
        this.removeSitePeers(siteId);
        namespace.emit('site:offline', { siteId });
      }
    }, siteGraceMs);
    recovery.unref();
    namespace.use((socket, next) => {
      try {
        const auth = socket.handshake.auth;
        const actual = Buffer.from(typeof auth.secret === 'string' ? auth.secret : '');
        const expected = Buffer.from(secret);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
          throw new Error('Unauthorized cluster connection');
        const site = auth.site as Site;
        if (
          auth.version !== 1 ||
          !site ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(site.id) ||
          !isIP(site.pipeAddress) ||
          !site.instanceId
        )
          throw new Error('Invalid cluster registration');
        if (site.url) validateOrigin(site.url);
        if (this.sites.get(site.id)?.socket.connected) throw new Error('SITE_ID is already connected');
        next();
      } catch (error) {
        next(error instanceof Error ? error : new Error(String(error)));
      }
    });
    namespace.on('connection', (socket) => {
      const site = socket.handshake.auth.site as Site;
      const old = this.sites.get(site.id);
      if (old?.expiry) clearTimeout(old.expiry);
      const previousSite = this.knownSites.get(site.id);
      if (previousSite && previousSite.instanceId !== site.instanceId)
        namespace.emit('site:offline', { siteId: site.id });
      this.knownSites.set(site.id, site);
      const entry: RegisteredSite = { site, socket, registered: false };
      this.sites.set(site.id, entry);
      socket.on('request', async (request: ControlRequest, reply: (result: ControlReply) => void) => {
        if (typeof reply !== 'function') return;
        try {
          if (!request || !socket.connected || this.sites.get(site.id) !== entry) throw new Error('Site disconnected');
          if (request.action !== 'register' && !entry.registered) throw new Error('Site not registered');
          reply({ ok: true, value: await this.handle(entry, request) });
        } catch (error) {
          reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
      socket.on('disconnect', () => {
        entry.expiry = setTimeout(() => {
          if (this.sites.get(site.id) !== entry) return;
          this.sites.delete(site.id);
          this.removeSitePeers(site.id);
          namespace.emit('site:offline', { siteId: site.id });
        }, siteGraceMs);
        entry.expiry.unref();
      });
    });
    const timer = setInterval(() => {
      let changed = false;
      for (const [id, room] of this.rooms) {
        if (!room.peers.length && room.emptySince !== null && Date.now() - room.emptySince >= RETENTION_MS) {
          this.rooms.delete(id);
          changed = true;
        }
      }
      if (changed) this.save();
    }, 5000);
    timer.unref();
    io.engine.on('close', () => {
      clearInterval(timer);
      clearTimeout(recovery);
      for (const entry of this.sites.values()) if (entry.expiry) clearTimeout(entry.expiry);
    });
  }

  private statistics(): Promise<ClusterStatistics> {
    if (this.statisticsCache && Date.now() - this.statisticsCache.sampledAt < 5000)
      return Promise.resolve(this.statisticsCache);
    return (this.statisticsPending ??= this.collectStatistics()
      .then((value) => (this.statisticsCache = value))
      .finally(() => {
        this.statisticsPending = undefined;
      }));
  }

  private async collectStatistics(): Promise<ClusterStatistics> {
    const sites = await Promise.all(
      [...this.knownSites.values()].map(async (site): Promise<ClusterStatistics['sites'][number]> => {
        const entry = this.sites.get(site.id);
        const base = { id: site.id, url: site.url, metrics: null };
        if (!entry?.registered || !entry.socket.connected) return { ...base, status: 'offline' };
        try {
          const response: ControlReply = await entry.socket.timeout(3500).emitWithAck('statistics');
          if (!entry.socket.connected || this.sites.get(site.id) !== entry) return { ...base, status: 'offline' };
          if (!response.ok) throw new Error('Statistics unavailable');
          const metrics = response.value as SfuStatistics;
          if (!metrics || !Number.isFinite(metrics.sampledAt)) throw new Error('Invalid statistics');
          return { ...base, status: 'online', metrics };
        } catch {
          return { ...base, status: entry.socket.connected ? 'unavailable' : 'offline' };
        }
      }),
    );
    return {
      sampledAt: Date.now(),
      rooms: [...this.rooms.values()].filter((room) => room.peers.length).length,
      peers: [...this.rooms.values()].reduce((sum, room) => sum + room.peers.length, 0),
      sites,
    };
  }

  private save() {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(
      `${this.stateFile}.tmp`,
      JSON.stringify({ version: 1, rooms: [...this.rooms.values()], sites: [...this.knownSites.values()] }),
    );
    renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }

  private broadcast(room: RoomSnapshot, extraSites: string[] = []) {
    room.emptySince = room.peers.length ? null : (room.emptySince ?? Date.now());
    const targets = new Set([...room.peers.map((peer) => peer.siteId), ...extraSites]);
    for (const id of targets) this.sites.get(id)?.socket.emit('room:update', room);
  }

  private removeSitePeers(siteId: string) {
    for (const room of this.rooms.values()) {
      if (!room.peers.some((peer) => peer.siteId === siteId)) continue;
      room.peers = room.peers.filter((peer) => peer.siteId !== siteId);
      this.broadcast(room, [siteId]);
    }
    this.save();
  }

  private room(id: string) {
    const room = this.rooms.get(id);
    if (!room) throw new Error('ルームが見つかりません');
    return room;
  }

  private peer(room: RoomSnapshot, siteId: string, peerId: string): ClusterPeer {
    const peer = room.peers.find((peer) => peer.id === peerId && peer.siteId === siteId);
    if (!peer) throw new Error('Participant not found on this SFU');
    return peer;
  }

  private async handle(entry: RegisteredSite, request: ControlRequest): Promise<unknown> {
    const siteId = entry.site.id;
    switch (request.action) {
      case 'register': {
        if (!Array.isArray(request.rooms)) throw new Error('Invalid room snapshot');
        const changed = new Set<RoomSnapshot>();
        for (const room of this.rooms.values()) {
          if (room.peers.some((peer) => peer.siteId === siteId)) {
            room.peers = room.peers.filter((peer) => peer.siteId !== siteId);
            changed.add(room);
          }
        }
        for (const local of request.rooms) {
          if (!local.peers.length) continue;
          let room = this.rooms.get(local.id);
          if (!room) {
            room = { id: local.id, name: local.name, peers: [], emptySince: null };
            this.rooms.set(room.id, room);
          }
          room.peers.push(...local.peers.map((peer) => ({ ...peer, siteId })));
          changed.add(room);
        }
        entry.registered = true;
        for (const room of changed) this.broadcast(room, [siteId]);
        this.save();
        return [...changed];
      }
      case 'statistics':
        return this.statistics();
      case 'sites':
        return [...this.sites.values()]
          .filter((site) => site.registered && site.socket.connected)
          .map(({ site }) => ({ id: site.id, url: site.url }));
      case 'rooms':
        return [...this.rooms.values()].map((room) => ({
          id: room.id,
          name: room.name,
          peopleCount: room.peers.length,
          expiresAt: room.emptySince === null ? null : room.emptySince + RETENTION_MS,
          remainingMs: room.emptySince === null ? null : Math.max(0, room.emptySince + RETENTION_MS - Date.now()),
        }));
      case 'join': {
        if (!request.peerId || typeof request.name !== 'string') throw new Error('Invalid participant');
        let room: RoomSnapshot;
        if (request.roomId) room = this.room(request.roomId);
        else {
          let id: string;
          do {
            id = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
          } while (this.rooms.has(id));
          room = { id, name: `${request.name.slice(0, 40)}の部屋`, peers: [], emptySince: null };
          this.rooms.set(id, room);
        }
        if (room.peers.some((peer) => peer.id === request.peerId)) throw new Error('Participant already joined');
        room.peers.push({ id: request.peerId, name: request.name.slice(0, 40), shares: [], siteId });
        this.broadcast(room);
        this.save();
        return room;
      }
      case 'leave': {
        const room = this.rooms.get(request.roomId);
        if (!room) return;
        room.peers = room.peers.filter((peer) => peer.id !== request.peerId || peer.siteId !== siteId);
        this.broadcast(room, [siteId]);
        this.save();
        return;
      }
      case 'publish': {
        const room = this.room(request.roomId);
        const peer = this.peer(room, siteId, request.peerId);
        if (request.share.appData.compatibilityFor) throw new Error('Compatibility streams are not room listings');
        peer.shares = [...peer.shares.filter((share) => share.id !== request.share.id), request.share];
        this.broadcast(room);
        this.save();
        return;
      }
      case 'unpublish': {
        const room = this.rooms.get(request.roomId);
        const peer = room?.peers.find((peer) => peer.id === request.peerId && peer.siteId === siteId);
        if (room && peer) {
          peer.shares = peer.shares.filter((share) => share.id !== request.producerId);
          this.broadcast(room);
          this.save();
        }
        return;
      }
      case 'sync':
        return this.room(request.roomId);
      case 'relay': {
        const target = this.sites.get(request.siteId);
        if (!target?.registered || !target.socket.connected) throw new Error('配信元の拠点に接続できません');
        const command = request.command;
        if (command.action === 'resolve' || command.action === 'open') {
          const room = this.room(command.roomId);
          if (
            !room.peers.some((peer) => peer.siteId === siteId) ||
            !room.peers.some((peer) => peer.siteId === request.siteId)
          )
            throw new Error('Sites must participate in the same room');
        }
        const response: ControlReply = await target.socket
          .timeout(14000)
          .emitWithAck('operation', { from: entry.site, command });
        if (!response.ok) throw new Error(response.error);
        return response.value;
      }
      default:
        throw new Error('Unknown control operation');
    }
  }
}
