import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import type { NotificationPreferences } from '../../contracts';

/** Response shape — `implements` keeps it checked against ipscope-web's contract. */
export class NotificationPreferencesDto implements NotificationPreferences {
  @ApiProperty() monitorAlerts: boolean;
  @ApiProperty() securityAlerts: boolean;
  @ApiProperty() weeklyDigest: boolean;
  @ApiProperty() usageWarnings: boolean;
  @ApiProperty() productUpdates: boolean;
}

/** Partial update: send only the switches that changed. */
export class UpdateNotificationsDto implements Partial<NotificationPreferences> {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  monitorAlerts?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  securityAlerts?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  weeklyDigest?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  usageWarnings?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  productUpdates?: boolean;
}
