import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsNewPassword } from '../../common/validators/credentials.validators';

export class ResetPasswordDto {
  @ApiProperty({ description: 'The token from the emailed reset link.' })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;

  @ApiProperty({ minLength: 10, maxLength: 128 })
  @IsNewPassword()
  password: string;
}
