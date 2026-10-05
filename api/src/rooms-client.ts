export async function fetchRoomList(sfuUrl: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImpl(`${sfuUrl}/internal/rooms`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`SFU returned ${response.status}`);
  return response.json();
}
