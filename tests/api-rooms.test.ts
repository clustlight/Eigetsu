import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listRooms } from '../api/src/rooms-controller-logic.ts';
import { fetchRoomList } from '../api/src/rooms-client.ts';

test('room API client requests JSON from the SFU and returns the parsed room list', async () => {
  const rooms = [{ id: 'ROOM01', name: 'Study', peopleCount: 2 }];
  let requestedUrl = '';
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestInit = init;
    return Response.json(rooms);
  };

  assert.deepEqual(await fetchRoomList('http://sfu:3000', fetchImpl), rooms);
  assert.equal(requestedUrl, 'http://sfu:3000/internal/rooms');
  assert.equal(new Headers(requestInit?.headers).get('accept'), 'application/json');
  assert.ok(requestInit?.signal instanceof AbortSignal);
});

test('room API maps SFU HTTP errors, timeouts, and HTML responses to a 503', async () => {
  const upstreamFailures: Array<[string, typeof fetch]> = [
    ['HTTP 500', async () => new Response('unavailable', { status: 500 })],
    [
      'timeout',
      async () => {
        throw new DOMException('The operation was aborted', 'TimeoutError');
      },
    ],
    ['HTML instead of JSON', async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })],
  ];

  for (const [label, fetchImpl] of upstreamFailures) {
    await assert.rejects(listRooms({ list: () => fetchRoomList('http://sfu:3000', fetchImpl) }), (error: unknown) => {
      assert.ok(error instanceof Error, label);
      assert.equal(error.name, 'ServiceUnavailableException', label);
      assert.equal((error as Error & { getStatus(): number }).getStatus(), 503, label);
      assert.equal(error.message, 'The media server is unavailable', label);
      return true;
    });
  }
});
