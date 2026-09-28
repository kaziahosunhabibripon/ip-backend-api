import { ApiProperty } from '@nestjs/swagger';
import { IsNormalizedEmail } from '../../common/validators/credentials.validators';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'jane@company.com' })
  @IsNormalizedEmail()
  email: string;
}
