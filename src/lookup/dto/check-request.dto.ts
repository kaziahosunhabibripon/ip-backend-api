import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CheckRequestDto {
  @ApiProperty({
    example: 'https://www.google.com/search?q=x',
    description:
      'A domain, URL or public IP address exactly as the user typed it. The protocol, path, query and port are stripped; private and reserved addresses are rejected.',
  })
  @MaxLength(4096, { message: 'That input is too long.' })
  @IsString({ message: 'Enter a domain or IP address.' })
  target: string;

  @ApiProperty({
    required: false,
    default: false,
    description:
      'Skip the result cache and query the data sources again. Counts against quota.',
  })
  @IsOptional()
  @IsBoolean()
  refresh?: boolean;
}
