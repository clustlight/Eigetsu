import { Injectable } from '@nestjs/common';
import { fetchRoomList } from './rooms-client';

@Injectable()
export class RoomsService {
  private readonly sfuUrl = process.env.SFU_URL || 'http://localhost:3000';

  async list(): Promise<unknown> {
    return fetchRoomList(this.sfuUrl);
  }
}
