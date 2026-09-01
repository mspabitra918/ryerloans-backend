import type { AdminRole } from '../admin-users/models/admin-user.model';

/** Claims carried by an admin access token. */
export interface AdminJwtPayload {
  /** admin_users.id */
  sub: string;
  email: string;
  role: AdminRole;
  /** admin_sessions.id — lets a single session be revoked without a key roll. */
  sid: string;
  /**
   * §8.1 "Session bound to IP". Carried in the token as well as on the session
   * row so a stolen token cannot be replayed from elsewhere even if the session
   * table is briefly unavailable.
   */
  ip: string;
  /**
   * Unique per issued token. Every other claim is identical across a refresh,
   * and `iat`/`exp` only have one-second resolution, so without this a refresh
   * that lands in the same second as the token it replaces returns a
   * byte-identical string — indistinguishable, in a log or a bug report, from
   * a refresh that silently did nothing.
   */
  jti: string;
}

/** What the guard attaches to the request, and what @CurrentAdmin returns. */
export interface AuthenticatedAdmin {
  id: string;
  email: string;
  role: AdminRole;
  sessionId: string;
  ipAddress: string;
}

/**
 * Half-issued credential returned by POST /auth/login when the account has TOTP
 * enrolled. It authorises exactly one thing: completing the second factor.
 */
export interface MfaChallengePayload {
  sub: string;
  /** Distinguishes the challenge from a real access token at verify time. */
  purpose: 'mfa_challenge' | 'mfa_enrollment';
  ip: string;
}
