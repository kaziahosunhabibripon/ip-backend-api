import { ApiProperty } from '@nestjs/swagger';
import { QuotaDto, UserDto } from '../../common/dto/user.dto';

/** `POST /auth/login` and `POST /auth/register`. */
export class AuthUserPayloadDto {
  @ApiProperty({ type: UserDto })
  user: UserDto;
}

/** `GET /auth/me` — `user` is null for anonymous visitors. */
export class SessionPayloadDto {
  @ApiProperty({ type: UserDto, nullable: true })
  user: UserDto | null;

  @ApiProperty({ type: QuotaDto })
  quota: QuotaDto;
}
