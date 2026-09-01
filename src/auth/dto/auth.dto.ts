import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * §8.1 sign-in, step one. Either the email address or the short login code
 * (e.g. GFHR537F) identifies the account — agents are given the code because it
 * can be read over the phone without ambiguity.
 */
export class LoginDto {
  @IsString()
  @Length(3, 255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  declare identifier: string;

  @IsString()
  @MinLength(8)
  declare password: string;
}

/** §8.1 sign-in, step two. */
export class VerifyMfaDto {
  /** The short-lived challenge token returned by /auth/login. */
  @IsString()
  declare challenge_token: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit TOTP code' })
  declare code: string;
}

/** First-run TOTP enrollment, completed with the same challenge token. */
export class EnrollMfaDto {
  @IsString()
  declare challenge_token: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit TOTP code' })
  declare code: string;
}

/**
 * §8.1 token refresh. The token is opaque to the client — a random string, not
 * a JWT — so there is nothing to validate here beyond its shape; the bounds
 * exist only to keep obviously-junk input away from the hash-and-lookup.
 */
export class RefreshTokenDto {
  @IsString()
  @Length(20, 512)
  declare refresh_token: string;
}

export class ChangePasswordDto {
  @IsString()
  declare current_password: string;

  @IsString()
  @MinLength(12, {
    message: 'New password must be at least 12 characters',
  })
  declare new_password: string;
}

/**
 * §8.3 Reveal control: "requires password re-entry and writes to audit_log".
 */
export class RevealDto {
  @IsString()
  declare password: string;

  @IsString()
  @Length(1, 40)
  declare field: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  declare reason?: string;
}

export class CreateAdminUserDto {
  @IsEmail()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  declare email: string;

  @IsString()
  @MinLength(12)
  declare password: string;

  @IsString()
  declare role: string;

  @IsOptional()
  @IsString()
  @Length(6, 50)
  declare login_id?: string;
}

export class UpdateAdminUserDto {
  @IsOptional()
  @IsString()
  declare role?: string;

  @IsOptional()
  @IsBoolean()
  declare is_active?: boolean;
}
