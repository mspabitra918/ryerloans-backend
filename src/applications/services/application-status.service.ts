import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';

import { Application } from '../models/application.model';
import { BlockedAttempt } from '../models/blocked-attempt.model';
import { ApplicationStatus } from '../dto/application-enums';
import type { SelfServicePurpose } from '../dto/borrower-action.dto';
import { isTerminal } from '../application-status.machine';
import {
  SUPPORT_PHONE_DIGITS,
  SUPPORT_PHONE_DISPLAY,
} from '../application.types';
import { maskAccount, getLast4 } from '../../common/pii/mask.util';
import { BorrowerActionTokenService } from './borrower-action-token.service';

/** Failed lookups tolerated from one address before it is refused. */
const LOOKUP_ATTEMPT_LIMIT = 10;
const LOOKUP_WINDOW_MS = 15 * 60 * 1000;

/**
 * The borrower-facing status tracker.
 *
 * Everything here is unauthenticated, so the response is built field by field
 * from an allow-list rather than by stripping keys off the model — the previous
 * approach returned `...data` and relied on remembering to blank each secret,
 * which is one forgotten column away from a disclosure.
 */
@Injectable()
export class ApplicationStatusService {
  private readonly logger = new Logger(ApplicationStatusService.name);

  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    @InjectModel(BlockedAttempt)
    private readonly blockedAttemptModel: typeof BlockedAttempt,
    private readonly tokenService: BorrowerActionTokenService,
  ) {}

  async lookup(applicationId: string, email: string, ipAddress: string) {
    const application = await this.findByCredentials(
      applicationId,
      email,
      ipAddress,
    );

    return {
      application_id: application.application_id,
      submitted_at: application.created_at ?? null,
      status: application.status,

      /*
       * The borrower's own requested amount. Safe on this endpoint — they
       * already matched an Application ID to the email on the record — and the
       * §6.2 tracker cannot render "Application Received" honestly without it.
       */
      amount_requested: Number(application.amount_requested),

      tracker: {
        application_received: {
          status: 'completed',
          timestamp: application.created_at ?? null,
        },
        bank_verification: {
          status: application.bank_verified ? 'completed' : 'pending',
          timestamp: application.bank_verified_at ?? null,
        },
        verification_deposit: {
          status: this.depositStatus(application),
          timestamp:
            application.micro_deposit_confirmed_at ??
            application.micro_deposit_sent_at ??
            null,
        },
        final_status: {
          status: this.finalStatus(application),
          timestamp: application.decision_at ?? null,
        },
      },

      bank_verified: Boolean(application.bank_verified),
      called_in: Boolean(application.called_in),

      bank_verification_url: application.bank_verified
        ? null
        : this.bankVerificationUrl(),

      // Straight off the plaintext last-4 columns. The old implementation
      // decrypted the full account and routing numbers on this unauthenticated
      // endpoint purely to slice the last four characters off them.
      account_last4: maskAccount(application.account_last4),
      // routing_last4: getLast4(application.routing_encrypted),

      adverse_action:
        application.status === ApplicationStatus.DECLINED
          ? {
              reference: application.adverse_action_reference ?? null,
              reapply_eligible_date: application.reapply_eligible_date ?? null,
            }
          : null,

      call_banner: application.called_in
        ? null
        : {
            message:
              `Call ${SUPPORT_PHONE_DISPLAY} to continue your application. ` +
              `Have Application ID #${application.application_id} ready.`,
            phone: SUPPORT_PHONE_DIGITS,
          },

      standing_notice:
        'Ryer Loans will never ask you to send money, buy a gift card, or pay ' +
        'a fee before your loan is funded.',
    };
  }

  /**
   * §6.2 "do this now": mint a live link for the step the tracker is showing.
   *
   * The tracker used to hand these two buttons a static explainer page telling
   * the borrower to go and find an email, because an Application ID plus an
   * email address is a lookup rather than a credential. That was the correct
   * reading of the trust boundary and the wrong product: a borrower who could
   * already see "verify your bank" had no way to actually do it, and the two
   * buttons were dead ends.
   *
   * So the bar is now explicit rather than implied. The same two fields that
   * open the tracker also open these two steps, and the compensating controls
   * are the ones that were already here — the shared lookup throttle, the
   * generic failure message, and a fresh single-use token per click. What they
   * open still cannot move money or bind the borrower to anything: bank
   * verification is Plaid proving account ownership, and deposit confirmation
   * requires reading two amounts off the account's own statement. Agreement
   * signature is not on this list for exactly that reason.
   *
   * Issuing supersedes the outstanding link for the same purpose — the same
   * behaviour as an admin re-send, and the reason the borrower should use the
   * page they are standing on rather than an older email.
   */
  async issueActionLink(
    applicationId: string,
    email: string,
    purpose: SelfServicePurpose,
    ipAddress: string,
  ) {
    const application = await this.findByCredentials(
      applicationId,
      email,
      ipAddress,
    );

    this.assertActionable(application, purpose);

    const link = await this.tokenService.issue(application.id, purpose);

    /*
     * Site-relative. The tracker navigates within its own origin, and
     * buildUrl's absolute form is pinned to whatever host the emails point at.
     * The token itself never goes back as a bare value — there is nothing the
     * caller should do with it but follow this path.
     */
    return {
      purpose,
      path: this.tokenService.buildPath(purpose, link.token),
      expires_at: link.expiresAt,
    };
  }

  /**
   * Refuse a link for a step the file is not actually on.
   *
   * Mirrors the guards the §8.4 admin actions apply before sending the same
   * links, so the borrower cannot mint one the borrower-action service would
   * only reject after spending it.
   */
  private assertActionable(
    application: Application,
    purpose: SelfServicePurpose,
  ): void {
    if (isTerminal(application.status)) {
      throw new BadRequestException(
        'This application is closed, so there is nothing left to verify. ' +
          `Call ${SUPPORT_PHONE_DISPLAY} if that looks wrong.`,
      );
    }

    if (purpose === 'bank_verification') {
      if (application.bank_verified) {
        throw new BadRequestException(
          'Your bank account is already verified — nothing further is needed ' +
            'on this step.',
        );
      }

      return;
    }

    if (
      application.micro_deposit_confirmed_at ||
      application.micro_deposit_conf_at ||
      application.status === ApplicationStatus.VERIFICATION_DEPOSIT_CONFIRMED
    ) {
      throw new BadRequestException(
        'Your deposits are already confirmed — nothing further is needed on ' +
          'this step.',
      );
    }

    if (application.status !== ApplicationStatus.VERIFICATION_DEPOSIT_SENT) {
      throw new BadRequestException(
        'We have not sent your verification deposits yet. We will email you ' +
          'as soon as they are on their way.',
      );
    }
  }

  /**
   * The Application ID + email check, shared by the tracker and the two links
   * it can now open.
   *
   * One generic message for both a wrong id and a wrong email. Distinguishing
   * them would turn this endpoint into an oracle for which application ids
   * exist.
   */
  private async findByCredentials(
    applicationId: string,
    email: string,
    ipAddress: string,
  ): Promise<Application> {
    await this.enforceRateLimit(ipAddress);

    const application = await this.applicationModel.findOne({
      where: { application_id: (applicationId ?? '').trim().toUpperCase() },
    });

    if (
      !application ||
      application.email?.toLowerCase() !== email.trim().toLowerCase()
    ) {
      await this.recordFailedLookup(applicationId, email, ipAddress);

      throw new BadRequestException(
        'We could not verify the information provided. Please check your ' +
          'Application ID and email address and try again.',
      );
    }

    return application;
  }

  /**
   * Throttle by source address.
   *
   * Without this the lookup is an offline-speed oracle: application ids are six
   * characters, so an attacker who knows one email address can enumerate the
   * space. Failures are counted in blocked_attempts, which is already the
   * table for "someone tried something that did not work".
   */
  private async enforceRateLimit(ipAddress: string): Promise<void> {
    if (!ipAddress) return;

    const since = new Date(Date.now() - LOOKUP_WINDOW_MS);

    const attempts = await this.blockedAttemptModel.count({
      where: {
        ip_address: ipAddress,
        reason: 'status_lookup_failed',
        created_at: { [Op.gte]: since },
      },
    });

    if (attempts >= LOOKUP_ATTEMPT_LIMIT) {
      throw new HttpException(
        'Too many status lookups from this network. Please wait 15 minutes ' +
          `or call ${SUPPORT_PHONE_DISPLAY}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async recordFailedLookup(
    applicationId: string,
    email: string,
    ipAddress: string,
  ): Promise<void> {
    try {
      await this.blockedAttemptModel.create({
        email: (email ?? '').trim().toLowerCase(),
        phone: null,
        ssn_hash: null,
        ip_address: ipAddress || '0.0.0.0',
        user_agent: null,
        reason: 'status_lookup_failed',
        note: `application_id=${applicationId}`,
      } as never);
    } catch (error) {
      // The borrower still gets their error; losing the counter row only means
      // this attempt does not count towards the throttle.
      this.logger.warn(
        `Failed to record status lookup attempt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private depositStatus(application: Application): string {
    if (
      application.micro_deposit_confirmed_at ||
      application.micro_deposit_conf_at
    ) {
      return 'completed';
    }

    if (application.micro_deposit_sent_at) return 'pending';

    return 'not_sent';
  }

  private finalStatus(application: Application): string {
    const terminal: ApplicationStatus[] = [
      ApplicationStatus.APPROVED,
      ApplicationStatus.FUNDED,
      ApplicationStatus.DECLINED,
      ApplicationStatus.WITHDRAWN,
      ApplicationStatus.EXPIRED,
    ];

    return terminal.includes(application.status)
      ? application.status
      : 'in_progress';
  }

  /**
   * The fallback destination for a borrower who still needs to verify.
   *
   * Deliberately carries no identifier — it is the explainer page, not the
   * flow. The tracker's button now asks issueActionLink for a real single-use
   * link instead; this is what it falls back to when that call fails, and what
   * anything else reading the response gets. Keeping it identifier-free means
   * a cached or forwarded copy of this response opens nothing.
   */
  private bankVerificationUrl(): string {
    const base = (
      process.env.BORROWER_BASE_URL ??
      process.env.FRONTEND_URL ??
      'https://ryerloans.com'
    ).replace(/\/$/, '');

    return `${base}/bank-verification`;
  }
}
