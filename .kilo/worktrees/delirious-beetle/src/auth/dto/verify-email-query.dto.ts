import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class VerifyEmailQueryDto {
  @ApiProperty({ description: 'The token from the emailed verification link.' })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;
}
