import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import type {
  Alert,
  AlertCategory,
  AlertSeverity,
  AlertType,
} from '../../contracts';

export class AlertDto implements Alert {
  @ApiProperty({ example: 'ckx9a7q0n0000t2k1b2c3d4e5' })
  id: string;

  @ApiProperty({
    enum: ['dns_changed', 'ip_changed', 'security_changed', 'monitor_failed'],
  })
  type: AlertType;

  @ApiProperty({ enum: ['critical', 'high', 'medium', 'low', 'info'] })
  severity: AlertSeverity;

  @ApiProperty({ enum: ['security', 'dns', 'network'] })
  category: AlertCategory;

  @ApiProperty({ example: 'api.example.com' })
  target: string;

  @ApiProperty({
    example:
      'New address: 104.18.22.91 (Cloudflare). Addresses no longer returned: 93.184.216.34.',
  })
  message: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty()
  read: boolean;

  @ApiProperty({
    required: false,
    description:
      'Absent once the monitor that raised the alert has been deleted.',
  })
  monitorId?: string;
}

export class SetAlertReadDto {
  @ApiProperty({ description: 'true marks it read, false marks it unread.' })
  @IsBoolean()
  read: boolean;
}
