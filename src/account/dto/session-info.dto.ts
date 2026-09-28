import { ApiProperty } from '@nestjs/swagger';
import type { SessionInfo } from '../../contracts';

export class SessionInfoDto implements SessionInfo {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Chrome on Windows' })
  device: string;

  @ApiProperty({
    example: '203.0.113.7',
    description:
      'The IP the session was created from. Becomes a city/country once geolocation lands in Phase 2.',
  })
  location: string;

  @ApiProperty({ format: 'date-time' })
  lastActiveAt: string;

  @ApiProperty({ description: 'True for the session making this request.' })
  current: boolean;
}
