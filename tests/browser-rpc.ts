import type { Socket } from 'socket.io-client';
import type { Device } from 'mediasoup-client';
import type { RpcRequests, RpcResponses } from '../src/types.ts';

export function createRpc(socket: Socket, timeout = 15000) {
  return <E extends keyof RpcResponses>(event: E, ...args: E extends 'room:sync' ? [] : [RpcRequests[E]]) =>
    new Promise<RpcResponses[E]>((resolve, reject) => {
      socket
        .timeout(timeout)
        .emit(
          event,
          ...args,
          (error: Error | null, result: ({ ok: true } & RpcResponses[E]) | { ok: false; error: string }) => {
            if (error) reject(error);
            else if (!result?.ok) reject(new Error(result?.error || 'Missing RPC response'));
            else resolve(result);
          },
        );
    });
}

export interface BrowserPeer {
  socket: Socket;
  rpc: ReturnType<typeof createRpc>;
  device: Device;
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
