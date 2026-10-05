import { ServiceUnavailableException } from '@nestjs/common';

export async function listRooms(rooms: { list(): Promise<unknown> }): Promise<unknown> {
  try {
    return await rooms.list();
  } catch {
    throw new ServiceUnavailableException('The media server is unavailable');
  }
}
