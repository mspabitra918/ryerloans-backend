import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import {
  ChangePasswordDto,
  EnrollMfaDto,
  LoginDto,
  RefreshTokenDto,
  VerifyMfaDto,
} from './dto/auth.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import { AdminJwtGuard } from '../common/guards/admin-jwt.guard';
import { getClientIp } from '../common/utils/get-client-ip';
import type { AuthenticatedAdmin } from './auth.types';

@ApiTags('auth')
@Controller('auth')
@UseGuards(AdminJwtGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
  ) {}

  @Public()
  // Tighter than the global bucket: this is the one endpoint where guessing is
  // the attack, and the per-account lockout only bounds a single target.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Admin sign-in, step 1 — password' })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login({
      identifier: dto.identifier,
      password: dto.password,
      ipAddress: getClientIp(req),
    });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Admin sign-in, step 2 — TOTP code' })
  @HttpCode(HttpStatus.OK)
  @Post('mfa/verify')
  async verifyMfa(
    @Body() dto: VerifyMfaDto,
    @Req() req: Request,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.verifyMfa({
      challengeToken: dto.challenge_token,
      code: dto.code,
      ipAddress: getClientIp(req),
      userAgent,
    });
  }

  /**
   * Completing enrollment is the same operation as verifying — the code is
   * checked against the freshly minted secret and, on success, switches
   * mfa_enabled on. Kept as its own route so the client can be explicit about
   * which screen the admin is on.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Admin sign-in — confirm first-run TOTP enrollment',
  })
  @HttpCode(HttpStatus.OK)
  @Post('mfa/enroll')
  async enrollMfa(
    @Body() dto: EnrollMfaDto,
    @Req() req: Request,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.verifyMfa({
      challengeToken: dto.challenge_token,
      code: dto.code,
      ipAddress: getClientIp(req),
      userAgent,
    });
  }

  /**
   * Public because the access token it replaces is expected to be expired by
   * the time the portal calls this — requiring a live one would make the
   * endpoint useless in exactly the case it exists for. The refresh token in
   * the body is the credential, and it is checked against the session row.
   */
  @Public()
  // Refresh is once every fifteen minutes per tab in normal use. Anything near
  // this ceiling is a client stuck in a retry loop or someone working through
  // stolen tokens, and neither should be served at full speed.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair' })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return this.authService.refresh({
      refreshToken: dto.refresh_token,
      ipAddress: getClientIp(req),
    });
  }

  @ApiBearerAuth('admin-jwt')
  @ApiOperation({ summary: 'Current admin identity and session state' })
  @Get('me')
  me(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return { admin };
  }

  @ApiBearerAuth('admin-jwt')
  @ApiOperation({ summary: 'Sign out — revokes the current session' })
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.authService.logout(admin);
  }

  @ApiBearerAuth('admin-jwt')
  @ApiOperation({ summary: 'Active sessions for the current admin' })
  @Get('sessions')
  async sessions(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<{
    sessions: Array<{
      id: string;
      ip_address: string;
      user_agent: string | null;
      last_seen_at: Date;
      expires_at: Date;
      current: boolean;
    }>;
  }> {
    const sessions = await this.sessionService.listActiveForUser(admin.id);

    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        ip_address: session.ip_address,
        user_agent: session.user_agent,
        last_seen_at: session.last_seen_at,
        expires_at: session.expires_at,
        current: session.id === admin.sessionId,
      })),
    };
  }

  @ApiBearerAuth('admin-jwt')
  @ApiOperation({ summary: 'Change own password — revokes all other sessions' })
  @HttpCode(HttpStatus.OK)
  @Post('password')
  changePassword(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword({
      adminUserId: admin.id,
      currentPassword: dto.current_password,
      newPassword: dto.new_password,
    });
  }
}
