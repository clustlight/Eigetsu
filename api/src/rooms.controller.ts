import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { RoomsService } from './rooms.service';

@Controller()
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('api/rooms')
  async list() {
    try {
      return await this.rooms.list();
    } catch {
      throw new ServiceUnavailableException('The media server is unavailable');
    }
  }
}
