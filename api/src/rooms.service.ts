import { Injectable } from '@nestjs/common';

@Injectable()
export class RoomsService {
  private readonly sfuUrl = process.env.SFU_URL || 'http://localhost:3000';

  async list(): Promise<unknown> {
    const response = await fetch(`${this.sfuUrl}/internal/rooms`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`SFU returned ${response.status}`);
    return response.json();
  }
}
