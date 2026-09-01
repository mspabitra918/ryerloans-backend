import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import * as crypto from 'crypto';

import {
  BorrowerActionToken,
  BORROWER_ACTION_TTL_DAYS,
  type BorrowerActionPurpose,
} from '../models/borrower-action-token.model';

export interface IssuedToken {
  /** Plaintext, returned exactly once, to be embedded in the borrower email. */
  token: string;
  url: string;
  expiresAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Paths the borrower frontend serves for each one-time link.
 *
 * Kept beside the purposes rather than in brand.constants so that adding an
 * edge to §6.1 fails to compile until its landing page is named.
 */
const LANDING_PATHS: Record<BorrowerActionPurpose, string> = {
  bank_verification: '/bank-verification',
  agreement_signature: '/sign-agreement',
  deposit_confirmation: '/confirm-deposit',
};

/**
 * Mints and redeems the single-use links behind the §6.1 borrower edges.
 *
 * Deliberately its own service rather than more methods on the workflow
 * service: this is the only thing standing between an unauthenticated request
 * and a state transition, and it should be readable in one screen.
 */
@Injectable()
export class BorrowerActionTokenService {
  private readonly logger = new Logger(BorrowerActionTokenService.name);

  constructor(
    @InjectModel(BorrowerActionToken)
    private readonly tokenModel: typeof BorrowerActionToken,
  ) {}

  /**
   * Issue a fresh link, superseding any outstanding one for the same purpose.
   *
   * Superseding matters: §8.4 describes "Send Bank Verification" as issuing a
   * *fresh* link, and an admin re-sending one usually means the previous link
   * went to a compromised or mistyped address. Leaving it live would keep that
   * mistake usable for the rest of its TTL.
   */
  async issue(
    applicationId: string,
    purpose: BorrowerActionPurpose,
  ): Promise<IssuedToken> {
    await this.revokeOutstanding(applicationId, purpose);

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + BORROWER_ACTION_TTL_DAYS[purpose] * DAY_MS,
    );

    await this.tokenModel.create({
      application_id: applicationId,
      purpose,
      token_hash: hash(token),
      expires_at: expiresAt,
    });

    return { token, url: this.buildUrl(purpose, token), expiresAt };
  }

  /**
   * Redeem a link, or explain why not.
   *
   * The failure message is deliberately the same for "no such token",
   * "expired", "already used" and "superseded". A borrower who followed a stale
   * link and an attacker probing for live tokens get the same sentence, and
   * only the server log knows which happened.
   */
  async consume(
    token: string,
    purpose: BorrowerActionPurpose,
    ipAddress: string,
  ): Promise<{ applicationId: string; tokenId: string }> {
    const record = await this.tokenModel.findOne({
      where: { token_hash: hash(token), purpose },
    });

    const reason = this.rejectionReason(record);

    if (!record || reason) {
      this.logger.warn(
        `Rejected ${purpose} link from ${ipAddress}: ${reason ?? 'unknown token'}`,
      );

      throw new BadRequestException(
        'This link is no longer valid. It may have expired or already been ' +
          'used. Contact us and we will send you a new one.',
      );
    }

    /*
     * Consume before the caller acts on it. A transition that fails afterwards
     * costs the borrower a re-send; a token still live after a partial failure
     * is a replay, and this endpoint has no authentication behind it.
     *
     * The conditional UPDATE is the actual guard — two concurrent submissions
     * of the same link both reach here, and only the one that flips
     * consumed_at from NULL may proceed.
     */
    const [claimed] = await this.tokenModel.update(
      { consumed_at: new Date(), consumed_ip: ipAddress },
      { where: { id: record.id, consumed_at: null } },
    );

    if (claimed === 0) {
      throw new BadRequestException(
        'This link has already been used. Contact us and we will send you a ' +
          'new one.',
      );
    }

    return { applicationId: record.application_id, tokenId: record.id };
  }

  /**
   * Check a link without spending it.
   *
   * The Plaid flow needs the token twice — once to mint a link_token before the
   * borrower opens Plaid, and again to record the result afterwards. Consuming
   * on the first call would make the second one fail, so only the call that
   * actually advances the file consumes.
   */
  async verify(
    token: string,
    purpose: BorrowerActionPurpose,
  ): Promise<{ applicationId: string }> {
    const record = await this.tokenModel.findOne({
      where: { token_hash: hash(token), purpose },
    });

    const reason = this.rejectionReason(record);

    if (!record || reason) {
      throw new BadRequestException(
        'This link is no longer valid. It may have expired or already been ' +
          'used. Contact us and we will send you a new one.',
      );
    }

    return { applicationId: record.application_id };
  }

  /**
   * Hand a consumed token back when the action it authorised did not happen.
   *
   * Used for the failure a borrower can legitimately recover from — mistyping
   * the micro-deposit amounts — so a typo does not cost them the link.
   */
  async release(tokenId: string): Promise<void> {
    await this.tokenModel.update(
      { consumed_at: null, consumed_ip: null },
      { where: { id: tokenId } },
    );
  }

  async revokeOutstanding(
    applicationId: string,
    purpose: BorrowerActionPurpose,
  ): Promise<void> {
    await this.tokenModel.update(
      { revoked_at: new Date() },
      {
        where: {
          application_id: applicationId,
          purpose,
          consumed_at: null,
          revoked_at: null,
        },
      },
    );
  }

  buildUrl(purpose: BorrowerActionPurpose, token: string): string {
    /*
     * TEMPORARY (local testing): bank verification, deposit confirmation and
     * agreement signature links point at the local borrower frontend so the
     * emailed links are clickable during development.
     *
     * Restore the block below before deploying.
     */
    const base = 'http://localhost:3000';

    // const base = (
    //   process.env.BORROWER_BASE_URL ??
    //   process.env.FRONTEND_URL ??
    //   'https://ryerloans.com'
    // ).replace(/\/+$/, '');

    return `${base}${this.buildPath(purpose, token)}`;
  }

  /**
   * The same landing page, as a site-relative path.
   *
   * The §6.2 tracker navigates within its own origin, so it wants this rather
   * than buildUrl's absolute form — which is pinned to whatever host the emails
   * are meant to point at and would send a borrower off-site mid-flow.
   *
   * Path parameter, not a query string: the borrower frontend already routes
   * these as /bank-verification/[token], and a token in the path is not
   * carried in a Referer header the way a query string is.
   */
  buildPath(purpose: BorrowerActionPurpose, token: string): string {
    return `${LANDING_PATHS[purpose]}/${encodeURIComponent(token)}`;
  }

  /** Null when the token is usable. */
  private rejectionReason(record: BorrowerActionToken | null): string | null {
    if (!record) return 'unknown token';
    if (record.revoked_at) return 'superseded by a newer link';
    if (record.consumed_at) return 'already used';
    if (record.expires_at.getTime() <= Date.now()) return 'expired';
    return null;
  }

  /** Housekeeping for the expiry sweep — nothing depends on it running. */
  async purgeExpired(olderThan: Date): Promise<number> {
    return this.tokenModel.destroy({
      where: {
        expires_at: { [Op.lt]: olderThan },
        consumed_at: null,
      },
    });
  }
}

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
