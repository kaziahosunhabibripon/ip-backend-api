import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsNormalizedEmail } from '../../common/validators/credentials.validators';

export class LoginDto {
  @ApiProperty({ example: 'jane@company.com' })
  @IsNormalizedEmail()
  email: string;

  @ApiProperty()
  @IsString({ message: 'Enter your password.' })
  @IsNotEmpty({ message: 'Enter your password.' })
  @MaxLength(128, { message: 'Enter your password.' })
  password: string;

  @ApiProperty({
    required: false,
    default: false,
    description:
      'Keep the session for 30 days (persistent cookie) instead of ending it when the browser closes.',
  })
  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}
