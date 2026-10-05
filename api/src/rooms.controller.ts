import { Controller, Get } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { listRooms } from './rooms-controller-logic';

@Controller()
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('api/rooms')
  async list() {
    return listRooms(this.rooms);
  }
}
