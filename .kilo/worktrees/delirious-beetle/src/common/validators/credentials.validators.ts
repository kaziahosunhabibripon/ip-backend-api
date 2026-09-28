import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Same pattern as ipscope-web's `validateEmail`, so client and server agree on what a valid address is. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const EMAIL_MESSAGE =
  'Enter a valid email address, like name@company.com.';

export const PASSWORD_MESSAGE =
  'Use at least 10 characters with upper and lower case letters and a number or symbol.';

/** Trims and lowercases, so `Jane@X.com ` and `jane@x.com` are the same account. */
export const IsNormalizedEmail = () =>
  applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim().toLowerCase() : value,
    ),
    IsString({ message: EMAIL_MESSAGE }),
    MaxLength(254, { message: EMAIL_MESSAGE }),
    Matches(EMAIL_PATTERN, { message: EMAIL_MESSAGE }),
  );

/** Same three rules as ipscope-web's `checkPassword`, plus an upper bound so a huge body can't be used to burn CPU in the hasher. */
export const IsNewPassword = () =>
  applyDecorators(
    IsString({ message: PASSWORD_MESSAGE }),
    MinLength(10, { message: PASSWORD_MESSAGE }),
    MaxLength(128, { message: 'Passwords can be at most 128 characters.' }),
    Matches(/[a-z]/, { message: PASSWORD_MESSAGE }),
    Matches(/[A-Z]/, { message: PASSWORD_MESSAGE }),
    Matches(/[\d\W_]/, { message: PASSWORD_MESSAGE }),
  );

export const IsPersonName = () =>
  applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim() : value,
    ),
    IsString({ message: 'Enter your name.' }),
    MinLength(1, { message: 'Enter your name.' }),
    MaxLength(80, { message: 'Names can be at most 80 characters.' }),
  );
