import { ApiProperty } from '@nestjs/swagger';
import {
  IsNewPassword,
  IsNormalizedEmail,
  IsPersonName,
} from '../../common/validators/credentials.validators';

export class RegisterDto {
  @ApiProperty({ example: 'Jane Doe', maxLength: 80 })
  @IsPersonName()
  name: string;

  @ApiProperty({
    example: 'jane@company.com',
    description: 'Trimmed and lowercased before use.',
  })
  @IsNormalizedEmail()
  email: string;

  @ApiProperty({
    minLength: 10,
    maxLength: 128,
    description:
      'At least 10 characters, with upper and lower case letters and a number or symbol.',
  })
  @IsNewPassword()
  password: string;
}
