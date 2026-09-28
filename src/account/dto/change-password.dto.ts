import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsNewPassword } from '../../common/validators/credentials.validators';

export class ChangePasswordDto {
  @ApiProperty()
  @IsString({ message: 'Enter your current password.' })
  @IsNotEmpty({ message: 'Enter your current password.' })
  @MaxLength(128, { message: 'Enter your current password.' })
  currentPassword: string;

  @ApiProperty({ minLength: 10, maxLength: 128 })
  @IsNewPassword()
  newPassword: string;
}
