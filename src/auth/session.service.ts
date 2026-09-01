import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import * as crypto from 'crypto';

import { AdminSession } from './models/admin-session.model';

/**
 * §8.1 writes the idle timeout as 15 minutes. It is run at 2 hours: the desk
 * works a file across a call that routinely outlasts a quarter of an hour, and
 * signing an underwriter out mid-review was costing more than it protected.
 * This is the single authority on the window — the portal reads it back from
 * the login response rather than keeping a number of its own.
 *
 * Note that a refresh exchange slides this window (see `assertUsable`), so it
 * is the absolute cap below, not this, that decides when an admin signs in
 * again — see the note there about why this rule no longer fires at all.
 */
export const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Absolute session lifetime, measured from sign-in and never extended: two
 * hours after signing in an admin signs in again, whatever they were in the
 * middle of. A refresh exchange renews the access token inside this window but
 * cannot move its end — `rotateRefreshToken` copies `expires_at` across
 * untouched, so the refresh token dies on this clock too.
 *
 * This deliberately sits at the same length as IDLE_TIMEOUT_MS, which means
 * the idle rule can no longer fire on its own: an idle deadline is
 * `last_seen_at + 2h`, and that is never earlier than `created_at + 2h`. The
 * absolute clock ends every session. The idle check below is kept rather than
 * deleted because it is what takes over again the moment this cap is raised.
 */
export const ABSOLUTE_SESSION_MS = 2 * 60 * 60 * 1000;

/**
 * Bytes of entropy behind a refresh token. 32 is well past the point where
 * guessing is the weak link — the token is the only thing standing between a
 * caller and a fresh access token, and unlike a password it is never rate
 * limited per account.
 */
const REFRESH_TOKEN_BYTES = 32;

/** What a rotated pair looks like to the caller. */
export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

/**
 * Owns the §8.1 session rules: idle timeout, IP binding, and revocation.
 *
 * Kept separate from AuthService because these checks run on *every* admin
 * request, whereas AuthService runs at sign-in — mixing them made it hard to
 * see that the per-request path stays a single indexed primary-key read.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @InjectModel(AdminSession)
    private readonly sessionModel: typeof AdminSession,
  ) {}

  async create(params: {
    adminUserId: string;
    ipAddress: string;
    userAgent?: string | null;
  }): Promise<AdminSession> {
    const now = new Date();

    return this.sessionModel.create({
      admin_user_id: params.adminUserId,
      ip_address: params.ipAddress,
      user_agent: params.userAgent ?? null,
      last_seen_at: now,
      expires_at: new Date(now.getTime() + ABSOLUTE_SESSION_MS),
    });
  }

  /**
   * Validate a session for the current request and slide its idle window.
   *
   * Every rejection path revokes the row rather than merely refusing the
   * request: an idled-out or replayed-from-elsewhere session must not become
   * usable again if the next call happens to look legitimate.
   */
  async touch(params: {
    sessionId: string;
    adminUserId: string;
    ipAddress: string;
  }): Promise<AdminSession> {
    const session = await this.sessionModel.findByPk(params.sessionId);

    if (!session || session.admin_user_id !== params.adminUserId) {
      throw new UnauthorizedException('Session not found');
    }

    return this.assertUsable(session, params.ipAddress, { slide: true });
  }

  /**
   * The §8.1 checks, shared by the request path and the refresh path.
   *
   * Both paths slide. Holding a live refresh token is what keeps a session
   * alive: an admin who still has one is not asked to sign in again merely
   * because two quiet hours passed. The portal keeps its tokens in
   * localStorage, so they outlive the tab and the browser — which makes this
   * clock, not the browser's lifetime, the only thing that ends an untouched
   * session.
   *
   * The `slide: false` case is kept for callers that want to read a session
   * without claiming activity on its behalf.
   */
  private async assertUsable(
    session: AdminSession,
    ipAddress: string,
    opts: { slide: boolean },
  ): Promise<AdminSession> {
    if (session.revoked_at) {
      throw new UnauthorizedException(
        session.revoked_reason === 'idle_timeout'
          ? 'Session timed out. Please sign in again.'
          : 'Session is no longer valid',
      );
    }

    const now = new Date();

    if (session.expires_at <= now) {
      await this.revoke(session, 'expired');
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    if (now.getTime() - session.last_seen_at.getTime() > IDLE_TIMEOUT_MS) {
      await this.revoke(session, 'idle_timeout');
      throw new UnauthorizedException(
        'Session timed out. Please sign in again.',
      );
    }

    /*
     * §8.1 "Session bound to IP". A mismatch is treated as a stolen token, not
     * as a roaming user: the session is killed so the real owner has to sign in
     * again and the attacker's copy dies with it.
     */
    if (session.ip_address !== ipAddress) {
      await this.revoke(session, 'ip_mismatch');

      this.logger.warn(
        `Session ${session.id} presented from ${ipAddress}, ` +
          `bound to ${session.ip_address} — revoked`,
      );

      throw new UnauthorizedException(
        'Session is bound to a different network address. Please sign in again.',
      );
    }

    if (opts.slide) await session.update({ last_seen_at: now });

    return session;
  }

  /*
   * Every revoke path clears the refresh material as well as stamping
   * revoked_at. Leaving the hash behind would keep a live credential pointing
   * at a dead session — harmless only for as long as every read path remembers
   * to re-check revoked_at, which is exactly the kind of invariant that decays.
   */
  private static readonly REVOKED_FIELDS = {
    refresh_token_hash: null,
    previous_refresh_token_hash: null,
    refresh_token_expires_at: null,
  } as const;

  async revoke(session: AdminSession, reason: string): Promise<void> {
    await session.update({
      revoked_at: new Date(),
      revoked_reason: reason,
      ...SessionService.REVOKED_FIELDS,
    });
  }

  async revokeById(sessionId: string, reason: string): Promise<void> {
    await this.sessionModel.update(
      {
        revoked_at: new Date(),
        revoked_reason: reason,
        ...SessionService.REVOKED_FIELDS,
      },
      { where: { id: sessionId, revoked_at: null as unknown as Date } },
    );
  }

  /** Used when an account is deactivated or its role changes. */
  async revokeAllForUser(adminUserId: string, reason: string): Promise<number> {
    const [affected] = await this.sessionModel.update(
      {
        revoked_at: new Date(),
        revoked_reason: reason,
        ...SessionService.REVOKED_FIELDS,
      },
      { where: { admin_user_id: adminUserId, revoked_at: { [Op.is]: null } } },
    );

    return affected;
  }

  /* ------------------------------------------------------ refresh tokens */

  /**
   * Mint a refresh token for a session and store only its hash.
   *
   * Called once at sign-in and again on every rotation, so it is also the one
   * place that decides the token's life: the session's own `expires_at`. A
   * refresh token that outlived its session would quietly convert the two-hour
   * absolute cap into "until the client stops asking".
   */
  async issueRefreshToken(session: AdminSession): Promise<IssuedRefreshToken> {
    const token = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

    await session.update({
      refresh_token_hash: SessionService.hash(token),
      previous_refresh_token_hash: null,
      refresh_token_expires_at: session.expires_at,
    });

    return { token, expiresAt: session.expires_at };
  }

  /**
   * Exchange a presented refresh token for the session it belongs to.
   *
   * Validates but does not rotate — rotation is a separate step so the caller
   * can mint the new access token and the new refresh token together, and a
   * failure between the two does not retire a token the client still holds as
   * its only credential.
   */
  async consumeRefreshToken(params: {
    token: string;
    ipAddress: string;
  }): Promise<AdminSession> {
    const hash = SessionService.hash(params.token);

    const session = await this.sessionModel.findOne({
      where: { refresh_token_hash: hash },
    });

    if (!session) {
      await this.detectReuse(hash, params.ipAddress);

      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    const now = new Date();

    if (
      !session.refresh_token_expires_at ||
      session.refresh_token_expires_at <= now
    ) {
      await this.revoke(session, 'expired');
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    /*
     * Absolute expiry and IP binding apply here exactly as they do to a normal
     * request — refreshing must not be a way around either. The idle window,
     * though, slides: exchanging a refresh token is the client saying the
     * session is still in use, and the whole point of issuing one is that a
     * quiet stretch at the desk no longer costs a sign-in. The two-hour
     * absolute cap is what still ends every session on its own clock.
     */
    return this.assertUsable(session, params.ipAddress, { slide: true });
  }

  /**
   * Retire the current refresh token and hand back its successor.
   *
   * The outgoing hash is kept in `previous_refresh_token_hash` rather than
   * discarded, which is what makes a replay identifiable one generation later.
   */
  async rotateRefreshToken(session: AdminSession): Promise<IssuedRefreshToken> {
    const token = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

    await session.update({
      previous_refresh_token_hash: session.refresh_token_hash,
      refresh_token_hash: SessionService.hash(token),
      refresh_token_expires_at: session.expires_at,
      refresh_rotated_at: new Date(),
      refresh_count: session.refresh_count + 1,
    });

    return { token, expiresAt: session.expires_at };
  }

  /**
   * A token that is not current but *was* current is a replay, and the two
   * plausible causes — a stolen token being used behind the real admin, or the
   * real admin's client racing itself — are indistinguishable from here. Both
   * are answered by killing the session: the honest case costs one sign-in,
   * the other ends the intrusion.
   */
  private async detectReuse(hash: string, ipAddress: string): Promise<void> {
    const replayed = await this.sessionModel.findOne({
      where: { previous_refresh_token_hash: hash },
    });

    if (!replayed) return;

    this.logger.warn(
      `Retired refresh token for session ${replayed.id} replayed from ` +
        `${ipAddress} — revoking every session for admin ` +
        `${replayed.admin_user_id}`,
    );

    /*
     * Every session, not just this one. A refresh token only leaves the
     * browser by being taken, and whoever took it had the run of a machine
     * that may well hold the others too.
     */
    await this.revokeAllForUser(replayed.admin_user_id, 'refresh_reuse');
  }

  /**
   * Plain SHA-256, deliberately not bcrypt. A refresh token is 256 bits of
   * machine-generated entropy, so there is no dictionary to slow down, and the
   * lookup has to be an indexed equality match rather than a scan-and-compare
   * over every session row.
   */
  private static hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /* -------------------------------------------------------------- queries */

  async listActiveForUser(adminUserId: string): Promise<AdminSession[]> {
    return this.sessionModel.findAll({
      where: {
        admin_user_id: adminUserId,
        revoked_at: { [Op.is]: null },
        expires_at: { [Op.gt]: new Date() },
      },
      order: [['last_seen_at', 'DESC']],
    });
  }
}
