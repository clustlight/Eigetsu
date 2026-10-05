import type { types as Media } from 'mediasoup';
import type { PeerInfo, ShareAppData } from './types.js';

export interface Site {
  id: string;
  url: string;
  pipeAddress: string;
  instanceId: string;
}
export interface ClusterPeer extends PeerInfo {
  siteId: string;
}
export interface RoomSnapshot {
  id: string;
  name: string;
  peers: ClusterPeer[];
  emptySince: number | null;
}
export interface LocalSnapshot {
  id: string;
  name: string;
  peers: PeerInfo[];
}
export type ControlRequest =
  | { action: 'register'; rooms: LocalSnapshot[] }
  | { action: 'sites' | 'rooms' | 'statistics' }
  | { action: 'join'; roomId?: string; peerId: string; name: string }
  | { action: 'leave'; roomId: string; peerId: string }
  | { action: 'publish'; roomId: string; peerId: string; share: PeerInfo['shares'][number] }
  | { action: 'unpublish'; roomId: string; peerId: string; producerId: string }
  | { action: 'sync'; roomId: string }
  | { action: 'relay'; siteId: string; command: PipeCommand };

export interface PipeEndpoint {
  port: number;
  srtpParameters: Media.SrtpParameters;
}
export interface PipeDescription extends PipeEndpoint {
  producerId: string;
  kind: Media.MediaKind;
  rtpParameters: Media.RtpParameters;
  appData: ShareAppData;
}
export type PipeCommand =
  | { action: 'resolve'; roomId: string; producerId: string; rtpCapabilities: Media.RtpCapabilities }
  | { action: 'open'; roomId: string; producerId: string; linkId: string; endpoint: PipeEndpoint }
  | { action: 'active'; roomId: string; linkId: string; active: boolean }
  | { action: 'release'; roomId: string; linkId: string }
  | { action: 'closed'; roomId: string; linkId: string };
export type ControlReply = { ok: true; value: unknown } | { ok: false; error: string };
