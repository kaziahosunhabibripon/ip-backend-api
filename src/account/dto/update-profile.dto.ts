import { ApiProperty } from '@nestjs/swagger';
import {
  IsNormalizedEmail,
  IsPersonName,
} from '../../common/validators/credentials.validators';

export class UpdateProfileDto {
  @ApiProperty({ example: 'Jane Doe', maxLength: 80 })
  @IsPersonName()
  name: string;

  @ApiProperty({
    example: 'jane@company.com',
    description:
      'Changing the address marks it unverified and emails a new verification link.',
  })
  @IsNormalizedEmail()
  email: string;
}
