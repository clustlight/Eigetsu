import { io, type Socket } from 'socket.io-client';
import type { SfuStatistics } from './statistics-types.js';
import type { ControlReply, ControlRequest, LocalSnapshot, PipeCommand, RoomSnapshot, Site } from './cluster-types.js';

export class ClusterClient {
  readonly rooms = new Map<string, RoomSnapshot>();
  readonly site: Site;
  ready = false;
  onRoom: (room: RoomSnapshot) => void = () => {};
  onOffline: (siteId: string) => void = () => {};
  onOperation: (from: Site, command: PipeCommand) => Promise<unknown> = async () => {
    throw new Error('Not ready');
  };
  onReady: () => void = () => {};
  onStatistics: () => Promise<SfuStatistics> = async () => {
    throw new Error('Not ready');
  };
  private socket: Socket;
  private revision = 0;

  constructor(masterUrl: string, secret: string, site: Site, snapshot: () => LocalSnapshot[]) {
    this.site = site;
    this.socket = io(`${masterUrl}/cluster`, {
      autoConnect: false,
      transports: ['websocket'],
      auth: { secret, site, version: 1 },
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
    this.socket.on('room:update', (room: RoomSnapshot) => {
      this.rooms.set(room.id, room);
      this.onRoom(room);
      if (!room.peers.some((peer) => peer.siteId === site.id)) this.rooms.delete(room.id);
    });
    this.socket.on('site:offline', ({ siteId }: { siteId: string }) => this.onOffline(siteId));
    this.socket.on(
      'operation',
      async ({ from, command }: { from: Site; command: PipeCommand }, reply: (result: ControlReply) => void) => {
        try {
          reply({ ok: true, value: await this.onOperation(from, command) });
        } catch (error) {
          reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    this.socket.on('statistics', async (reply: (result: ControlReply) => void) => {
      if (typeof reply !== 'function') return;
      try {
        reply({ ok: true, value: await this.onStatistics() });
      } catch {
        reply({ ok: false, error: 'Statistics unavailable' });
      }
    });
    this.socket.on('connect', async () => {
      const id = this.socket.id;
      try {
        let rooms: RoomSnapshot[];
        let revision: number;
        do {
          revision = this.revision;
          rooms = await this.send<RoomSnapshot[]>({ action: 'register', rooms: snapshot() });
        } while (revision !== this.revision && this.socket.connected && this.socket.id === id);
        if (!this.socket.connected || this.socket.id !== id) return;
        this.rooms.clear();
        for (const room of rooms) {
          this.rooms.set(room.id, room);
          this.onRoom(room);
        }
        this.ready = true;
        this.onReady();
        console.info(`[cluster] site=${site.id} registered with master`);
      } catch (error) {
        console.error('[cluster] registration failed', error);
        this.socket.disconnect();
        setTimeout(() => this.socket.connect(), 2000).unref();
      }
    });
    this.socket.on('disconnect', () => {
      this.ready = false;
    });
    this.socket.on('connect_error', (error) => {
      console.warn(`[cluster] master unavailable: ${error.message}`);
      if (!this.socket.active) setTimeout(() => this.socket.connect(), 2000).unref();
    });
  }

  connect() {
    this.socket.connect();
  }

  async request<T = unknown>(request: ControlRequest): Promise<T> {
    if (['join', 'leave', 'publish', 'unpublish', 'voice'].includes(request.action)) this.revision++;
    if (!this.ready) throw new Error('ルーム管理サーバーに接続できません');
    return this.send<T>(request);
  }

  private async send<T>(request: ControlRequest): Promise<T> {
    if (!this.socket.connected) throw new Error('Master disconnected');
    const response: ControlReply = await this.socket.timeout(16000).emitWithAck('request', request);
    if (!response.ok) throw new Error(response.error);
    return response.value as T;
  }

  relay<T = unknown>(siteId: string, command: PipeCommand) {
    return this.request<T>({ action: 'relay', siteId, command });
  }
}
