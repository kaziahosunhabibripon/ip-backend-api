import { ApiProperty } from '@nestjs/swagger';
import type { Plan, QuotaSnapshot, Role, User } from '../../contracts';
import { PLAN_ORDER } from '../plans';

/** Response shape of a user — `implements User` makes the compiler check it against ipscope-web's contract. */
export class UserDto implements User {
  @ApiProperty({ example: 'cm1abc2de0000xyz' })
  id: string;

  @ApiProperty({ example: 'Jane Doe' })
  name: string;

  @ApiProperty({ example: 'jane@company.com' })
  email: string;

  @ApiProperty({ enum: ['user', 'admin'] })
  role: Role;

  @ApiProperty({
    enum: PLAN_ORDER,
    description: 'What this account has paid for.',
  })
  plan: Plan;

  @ApiProperty({
    enum: PLAN_ORDER,
    description:
      'What this account may actually use right now — `plan`, or a team owner’s plan while an active member of their team, if higher. Every feature and limit goes by this one; billing pages should show `plan` instead.',
  })
  effectivePlan: Plan;

  @ApiProperty()
  emailVerified: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class QuotaDto implements QuotaSnapshot {
  @ApiProperty({ enum: ['anonymous', 'account'] })
  scope: QuotaSnapshot['scope'];

  @ApiProperty({ description: 'Lookups used in the current period.' })
  used: number;

  @ApiProperty()
  limit: number;

  @ApiProperty({ enum: ['day', 'month'] })
  period: QuotaSnapshot['period'];

  @ApiProperty({ format: 'date-time' })
  resetsAt: string;
}
