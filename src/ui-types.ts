import type { ListedRoom, Room, Share } from './types.ts';

interface AudioControls {
  onVolume(id: string, volume: number): void;
  onToggleMute(id: string): void;
  onFullscreen(element: HTMLElement | null): void;
}
export interface LobbyProps {
  rooms: ListedRoom[];
  displayName: string;
  setDisplayName(value: string): void;
  onCreate(): void;
  onJoin(id: string): void;
  notice: string;
  noticeError: boolean;
}
export interface RoomViewProps extends AudioControls {
  room: Room;
  shares: Share[];
  allShareCount: number;
  focused: boolean;
  presetId: string;
  onPreset(id: string): void;
  onFocus(id: string | null): void;
  onStartShare(): void;
  onStopShare(id: string): void;
  onPopout(id: string | undefined): void;
  onCopy(): void;
  onLeave(): void;
  onTogglePreview(id: string): void;
  notice: string;
  noticeError: boolean;
}
export interface PopoutProps extends AudioControls {
  share?: Share;
  errorMessage: string;
  onClose(): void;
}
