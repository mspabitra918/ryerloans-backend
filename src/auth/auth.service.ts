import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import * as QRCode from 'qrcode';

import { AdminRole, AdminUser } from '../admin-users/models/admin-user.model';
import { AdminSession } from './models/admin-session.model';
import {
  SessionService,
  IDLE_TIMEOUT_MS,
  type IssuedRefreshToken,
} from './session.service';
import type {
  AdminJwtPayload,
  AuthenticatedAdmin,
  MfaChallengePayload,
} from './auth.types';

/** §8.1: "Account lock after 5 failed attempts." */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * The access token is deliberately short-lived: it is a bearer credential, so
 * anything that gets a copy of it can act as the admin for as long as it is
 * valid, from the bound IP, with no way to tell the difference.
 *
 * Fifteen minutes is what the refresh token buys. Before it existed this had
 * to cover the whole idle window — over two hours — because letting it lapse
 * meant signing the admin out mid-file. With rotation the client renews
 * silently, so the exposure window is now the renewal interval instead of the
 * session length.
 */
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** A half-authenticated user has two minutes to produce a TOTP code. */
const CHALLENGE_TTL_SECONDS = 120;

/**
 * First-run enrollment gets a longer window. The admin has to open an
 * authenticator app, scan the QR and only then read a code off it, which
 * routinely takes longer than the two minutes a returning user needs to copy a
 * code that is already on their screen. The expired challenge came back as a
 * 401 that read like a rejected code, so the admin retyped correct codes into
 * a dead token.
 */
const ENROLLMENT_TTL_SECONDS = 10 * 60;

export interface LoginChallenge {
  mfa_required: true;
  /** 'verify' when TOTP is enrolled, 'enroll' on first sign-in. */
  mfa_stage: 'verify' | 'enroll';
  challenge_token: string;
  expires_in: number;
  /** Only present for 'enroll' — the secret the authenticator app needs. */
  enrollment?: {
    secret: string;
    otpauth_url: string;
    qr_data_url: string;
  };
}

export interface LoginSuccess {
  access_token: string;
  expires_in: number;
  /**
   * Exchanged at POST /auth/refresh for a new pair. Single use — presenting it
   * twice is treated as theft and ends every session the admin holds.
   */
  refresh_token: string;
  /** Seconds until the refresh token dies, i.e. the session's absolute cap. */
  refresh_expires_in: number;
  idle_timeout_seconds: number;
  admin: {
    id: string;
    email: string;
    login_id: string;
    role: AdminRole;
    last_login_at: Date | null;
  };
}

/**
 * §8.1 authentication: password, mandatory TOTP, lockout, and session issue.
 *
 * Password verification and MFA are two separate round trips on purpose. The
 * first returns a challenge token that can do nothing except complete the
 * second factor, so a leaked password alone never yields anything that the
 * admin API will accept.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(AdminUser)
    private readonly adminUserModel: typeof AdminUser,
    private readonly jwtService: JwtService,
    private readonly sessionService: SessionService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Step one. Always ends in a challenge — there is no path here that returns
   * an access token, because §8.1 makes TOTP mandatory for every role.
   */
  async login(params: {
    identifier: string;
    password: string;
    ipAddress: string;
  }): Promise<LoginChallenge> {
    const user = await this.findByIdentifier(params.identifier);

    /*
     * bcrypt is compared even when no user matched, against a fixed dummy hash.
     * Returning early would make "unknown account" measurably faster than
     * "wrong password" and turn this endpoint into an account enumerator.
     */
    if (!user) {
      await this.dummyCompare(params.password);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.is_active) {
      await this.dummyCompare(params.password);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.locked_until && user.locked_until > new Date()) {
      throw new ForbiddenException(
        `Account locked until ${user.locked_until.toISOString()} after ` +
          `${MAX_FAILED_ATTEMPTS} failed sign-in attempts.`,
      );
    }

    const matches = await bcrypt.compare(params.password, user.password_hash);

    if (!matches) {
      await this.registerFailedAttempt(user);
      throw new UnauthorizedException('Invalid credentials');
    }

    /*
     * The counter is cleared here, not after MFA: the password was correct, so
     * the brute-force budget this counter exists to bound has been reset. MFA
     * failures are rate-limited by the challenge token's two-minute life.
     */
    await user.update({ failed_attempts: 0, locked_until: null });

    if (user.mfa_enabled && user.mfa_secret) {
      return {
        mfa_required: true,
        mfa_stage: 'verify',
        challenge_token: await this.issueChallenge(
          user,
          'mfa_challenge',
          params.ipAddress,
        ),
        expires_in: CHALLENGE_TTL_SECONDS,
      };
    }

    return this.beginEnrollment(user, params.ipAddress);
  }

  /**
   * First sign-in: mint a TOTP secret and hand back the provisioning material.
   *
   * The secret is stored immediately but `mfa_enabled` stays false until a
   * valid code proves the admin actually scanned it — otherwise a mistyped
   * enrollment would lock the account out of its own portal.
   */
  private async beginEnrollment(
    user: AdminUser,
    ipAddress: string,
  ): Promise<LoginChallenge> {
    /*
     * A pending secret is reused rather than replaced. Re-running step one — a
     * refresh, a second tab, the "start over" button — would otherwise retire
     * the secret the admin had already scanned, and every code their app
     * produced from then on was rejected as invalid.
     */
    const secret = user.mfa_secret ?? generateSecret();
    const issuer = this.configService.get<string>(
      'MFA_ISSUER',
      'Ryer Loans Admin',
    );
    const otpauthUrl = generateURI({ issuer, label: user.email, secret });

    await user.update({ mfa_secret: secret, mfa_enabled: false });

    return {
      mfa_required: true,
      mfa_stage: 'enroll',
      challenge_token: await this.issueChallenge(
        user,
        'mfa_enrollment',
        ipAddress,
      ),
      expires_in: ENROLLMENT_TTL_SECONDS,
      enrollment: {
        secret,
        otpauth_url: otpauthUrl,
        qr_data_url: await QRCode.toDataURL(otpauthUrl),
      },
    };
  }

  /** Step two: verify the TOTP code and issue the real session. */
  async verifyMfa(params: {
    challengeToken: string;
    code: string;
    ipAddress: string;
    userAgent?: string | null;
  }): Promise<LoginSuccess> {
    const payload = await this.decodeChallenge(
      params.challengeToken,
      params.ipAddress,
    );
    const user = await this.adminUserModel.findByPk(payload.sub);

    if (!user || !user.is_active || !user.mfa_secret) {
      throw new UnauthorizedException('Invalid challenge');
    }

    /*
     * epochTolerance accepts the adjacent 30-second windows: hand-typed codes
     * routinely arrive a few seconds after they were read off the screen, and
     * a strictly-current-window check rejects a correct code often enough that
     * admins start blaming the portal.
     */
    const result = await verifyOtp({
      secret: user.mfa_secret,
      token: params.code,
      epochTolerance: 30,
    });

    if (!result.valid) {
      this.logger.warn(
        `Failed TOTP for admin ${user.email} from ${params.ipAddress}`,
      );
      throw new UnauthorizedException('Invalid authentication code');
    }

    const success = await this.issueSession(
      user,
      params.ipAddress,
      params.userAgent,
    );

    /*
     * Completing an enrollment challenge is what actually turns MFA on — but
     * only after the session exists. Flipping the flag first meant that any
     * failure while issuing the session left the account marked as enrolled
     * against a secret the admin never got to keep, and the next sign-in asked
     * for codes that nothing could produce.
     */
    if (!user.mfa_enabled) {
      await user.update({ mfa_enabled: true });
    }

    return success;
  }

  private async issueSession(
    user: AdminUser,
    ipAddress: string,
    userAgent?: string | null,
  ): Promise<LoginSuccess> {
    const session = await this.sessionService.create({
      adminUserId: user.id,
      ipAddress,
      userAgent,
    });

    await user.update({ last_login_at: new Date(), last_login_ip: ipAddress });

    const refresh = await this.sessionService.issueRefreshToken(session);

    return this.buildSuccess(user, session, refresh, ipAddress);
  }

  /**
   * Exchange a refresh token for a new access/refresh pair (§8.1).
   *
   * Deliberately not a way around the rules that matter: absolute expiry, IP
   * binding and revocation are all re-checked. The idle window is the one
   * thing an exchange does move, because holding a live refresh token is
   * itself evidence the session is still in use — a two-hour quiet stretch no
   * longer costs a sign-in. Rotation is unconditional — the presented token is dead
   * the moment this returns, whether or not the client manages to store its
   * replacement, because a refresh token that survives its own use is a
   * credential an attacker can keep replaying alongside the real admin.
   */
  async refresh(params: {
    refreshToken: string;
    ipAddress: string;
  }): Promise<LoginSuccess> {
    const session = await this.sessionService.consumeRefreshToken({
      token: params.refreshToken,
      ipAddress: params.ipAddress,
    });

    const user = await this.adminUserModel.findByPk(session.admin_user_id);

    /*
     * The account can have been deactivated since sign-in. Checking here is
     * what makes deactivation take effect within one access-token lifetime
     * rather than at the end of the two-hour session.
     */
    if (!user || !user.is_active) {
      await this.sessionService.revoke(session, 'admin_revoked');
      throw new UnauthorizedException('Admin account is not available');
    }

    const refresh = await this.sessionService.rotateRefreshToken(session);

    return this.buildSuccess(user, session, refresh, params.ipAddress);
  }

  /** The one shape both sign-in and refresh hand back. */
  private async buildSuccess(
    user: AdminUser,
    session: AdminSession,
    refresh: IssuedRefreshToken,
    ipAddress: string,
  ): Promise<LoginSuccess> {
    const payload: AdminJwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: session.id,
      ip: ipAddress,
      jti: crypto.randomUUID(),
    };

    return {
      access_token: await this.jwtService.signAsync(payload, {
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      }),
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refresh.token,
      refresh_expires_in: Math.max(
        0,
        Math.floor((refresh.expiresAt.getTime() - Date.now()) / 1000),
      ),
      idle_timeout_seconds: Math.floor(IDLE_TIMEOUT_MS / 1000),
      admin: {
        id: user.id,
        email: user.email,
        login_id: user.login_id,
        role: user.role,
        last_login_at: user.last_login_at ?? null,
      },
    };
  }

  async logout(admin: AuthenticatedAdmin): Promise<{ success: true }> {
    await this.sessionService.revokeById(admin.sessionId, 'logout');
    return { success: true };
  }

  /**
   * Re-assert the password without minting anything (§8.3 Reveal, §8.4 SSN and
   * bank-account edits). Returns silently on success and throws otherwise, so
   * callers can treat it as a precondition.
   */
  async assertPassword(
    adminUserId: string,
    password: string,
  ): Promise<AdminUser> {
    const user = await this.adminUserModel.findByPk(adminUserId);

    if (!user || !user.is_active) {
      throw new UnauthorizedException('Admin account is not available');
    }

    if (!(await bcrypt.compare(password, user.password_hash))) {
      throw new UnauthorizedException('Password re-entry failed');
    }

    return user;
  }

  async changePassword(params: {
    adminUserId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ success: true }> {
    const user = await this.assertPassword(
      params.adminUserId,
      params.currentPassword,
    );

    if (params.currentPassword === params.newPassword) {
      throw new BadRequestException(
        'New password must differ from the current one',
      );
    }

    await user.update({
      password_hash: await bcrypt.hash(params.newPassword, 12),
    });

    // Every other session for this account is now based on a secret the user
    // just chose to retire.
    await this.sessionService.revokeAllForUser(user.id, 'password_changed');

    return { success: true };
  }

  /** Accepts either the email address or the short login code. */
  private findByIdentifier(identifier: string): Promise<AdminUser | null> {
    const value = identifier.trim();

    return this.adminUserModel.findOne({
      where: value.includes('@')
        ? { email: value.toLowerCase() }
        : { login_id: { [Op.iLike]: value } },
    });
  }

  private async registerFailedAttempt(user: AdminUser): Promise<void> {
    const attempts = user.failed_attempts + 1;

    await user.update({
      failed_attempts: attempts,
      locked_until:
        attempts >= MAX_FAILED_ATTEMPTS
          ? new Date(Date.now() + LOCKOUT_MS)
          : null,
    });

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      this.logger.warn(
        `Admin account ${user.email} locked after ${attempts} attempts`,
      );
      await this.sessionService.revokeAllForUser(user.id, 'account_locked');
    }
  }

  /** Constant-ish work so a missing account costs the same as a wrong password. */
  private async dummyCompare(password: string): Promise<void> {
    await bcrypt.compare(
      password,
      '$2b$12$C6UzMDM.H6dfI/f/IKcEe.a3Zt1EGkoXQq9r1Xz0zPYsK5oWvS7Ha',
    );
  }

  private issueChallenge(
    user: AdminUser,
    purpose: MfaChallengePayload['purpose'],
    ipAddress: string,
  ): Promise<string> {
    const payload: MfaChallengePayload = {
      sub: user.id,
      purpose,
      ip: ipAddress,
    };

    return this.jwtService.signAsync(payload, {
      expiresIn:
        purpose === 'mfa_enrollment'
          ? ENROLLMENT_TTL_SECONDS
          : CHALLENGE_TTL_SECONDS,
    });
  }

  private async decodeChallenge(
    token: string,
    ipAddress: string,
  ): Promise<MfaChallengePayload> {
    let payload: MfaChallengePayload;

    try {
      payload = await this.jwtService.verifyAsync<MfaChallengePayload>(token);
    } catch {
      throw new UnauthorizedException(
        'Challenge expired. Please sign in again.',
      );
    }

    if (
      payload.purpose !== 'mfa_challenge' &&
      payload.purpose !== 'mfa_enrollment'
    ) {
      throw new UnauthorizedException('Invalid challenge token');
    }

    // The second factor must be presented from the address that passed the
    // first, so an intercepted challenge cannot be finished elsewhere.
    // Normalize common loopback and IPv4-mapped IPv6 forms so local
    // development (localhost vs 127.0.0.1 and ::1 vs ::ffff:127.0.0.1) does
    // not spuriously fail verification.
    const normalize = (ip: string | undefined | null): string => {
      if (!ip) return '';
      // IPv4-mapped IPv6 ("::ffff:127.0.0.1") -> "127.0.0.1"
      const v4match = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      if (v4match) return v4match[1];
      // IPv6 loopback -> IPv4 loopback for comparison
      if (ip === '::1') return '127.0.0.1';
      // Strip optional zone id (e.g. "%lo0") from IPv6 addresses
      const zoneIndex = ip.indexOf('%');
      if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);
      return ip;
    };

    if (normalize(payload.ip) !== normalize(ipAddress)) {
      throw new UnauthorizedException(
        'Network address changed during sign-in. Please start again.',
      );
    }

    return payload;
  }

  /**
   * Short human-facing login code (e.g. GFHR537F). Crockford-style alphabet:
   * no I/O/0/1, so a code read aloud over the phone cannot be mistyped.
   */
  static generateLoginId(): string {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const bytes = crypto.randomBytes(8);

    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join(
      '',
    );
  }
}
