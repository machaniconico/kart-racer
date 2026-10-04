export type ChannelKind = 'reliable' | 'unreliable';
export type WireData = string | ArrayBuffer;

export interface PeerLink {
  readonly peerId: string;
  send(kind: ChannelKind, data: WireData): void;
  close(): void;
  onMessage(handler: (kind: ChannelKind, data: WireData) => void): void;
  onClose(handler: (reason: string) => void): void;
}

export interface TransportHost {
  /** Actual normalized code; a broker ID collision can regenerate the requested one. */
  readonly roomCode: string;
  onJoin(handler: (link: PeerLink) => void): void;
  /** Reconnection failed; existing P2P links remain usable. Replayed to late subscribers. */
  onBrokerLost(handler: (error: TransportError) => void): void;
  close(): void;
}

export interface Transport {
  host(roomCode: string): Promise<TransportHost>;
  join(roomCode: string): Promise<PeerLink>;
}

export type TransportErrorCode =
  | 'broker_unreachable' | 'room_not_found' | 'room_taken' | 'ice_failed' | 'timeout';

export class TransportError extends Error {
  constructor(readonly code: TransportErrorCode, message: string = code) {
    super(message);
    this.name = 'TransportError';
  }
}
