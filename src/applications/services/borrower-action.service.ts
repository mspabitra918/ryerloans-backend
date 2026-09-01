import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';

import { Application } from '../models/application.model';
import { ApplicationStatus } from '../dto/application-enums';
import { borrowerActionOptions } from '../application.types';
import {
  ApplicationWorkflowService,
  type ActionResult,
} from './application-workflow.service';
import { BorrowerActionTokenService } from './borrower-action-token.service';

/**
 * §6.1 lets the borrower guess two 2-digit numbers this many times. Ten tries
 * against 1-in-9801 odds is generous to a borrower reading a bank statement and
 * useless to anyone else.
 */
const MAX_DEPOSIT_ATTEMPTS = 10;

/**
 * The three §6.1 transitions the borrower drives themselves — `[Plaid success
 * — auto]`, `[borrower e-signs]` and `[borrower confirms amounts]`.
 *
 * These lived on the admin controller behind AdminJwtGuard, which meant the
 * spec's borrower-labelled edges could only be walked by an employee clicking
 * on the borrower's behalf. They are their own service so the trust boundary
 * is visible in the file layout: nothing here takes an admin, and every entry
 * point starts by redeeming a one-time link.
 */
@Injectable()
export class BorrowerActionService {
  private readonly logger = new Logger(BorrowerActionService.name);

  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    private readonly workflowService: ApplicationWorkflowService,
    private readonly tokenService: BorrowerActionTokenService,
  ) {}

  /**
   * §6.1 `[Plaid success — auto]`.
   *
   * The borrower has finished the Plaid flow behind their one-time link. When
   * the Plaid integration lands, its webhook is the second caller of this —
   * signature-verified rather than token-authenticated — and nothing else here
   * changes.
   */
  async completeBankVerification(params: {
    token: string;
    plaidItemId?: string | null;
    ipAddress: string;
  }): Promise<BorrowerActionResponse> {
    const { applicationId } = await this.tokenService.consume(
      params.token,
      'bank_verification',
      params.ipAddress,
    );

    const application = await this.load(applicationId);

    /*
     * Already verified is a success, not an error. A borrower who double-taps
     * the button, or returns to the tab after Plaid redirected them, should see
     * the outcome they achieved rather than a failure for having done it twice.
     */
    if (application.bank_verified) {
      return this.describe(application, 'Your bank account is verified.');
    }

    const result = await this.workflowService.recordBankVerified(
      application.id,
      { plaidItemId: params.plaidItemId, ipAddress: params.ipAddress },
    );

    return this.fromAction(result, 'Your bank account is verified.');
  }

  /**
   * §6.1 `[borrower e-signs]`.
   *
   * The signature itself is the event an E-SIGN dispute turns on, so the audit
   * row records the borrower as the actor and the token row keeps the time and
   * IP the link was redeemed from.
   */
  async signAgreement(params: {
    token: string;
    ipAddress: string;
    /** Typed name, captured as the signature block. */
    fullName: string;
  }): Promise<BorrowerActionResponse> {
    const name = params.fullName.trim();

    if (name.length < 2) {
      throw new BadRequestException(
        'Type your full name exactly as it appears on your application to sign.',
      );
    }

    const { applicationId, tokenId } = await this.tokenService.consume(
      params.token,
      'agreement_signature',
      params.ipAddress,
    );

    const application = await this.load(applicationId);

    if (application.status === ApplicationStatus.AGREEMENT_SIGNED) {
      return this.describe(application, 'Your agreement is signed.');
    }

    if (application.status !== ApplicationStatus.AGREEMENT_SENT) {
      /*
       * The link outlived the state it belonged to — the file was withdrawn, or
       * an admin re-sent the agreement. Hand the token back so support can tell
       * the borrower to use their newest email rather than "your link is used".
       */
      await this.tokenService.release(tokenId);

      throw new BadRequestException(
        'This agreement is no longer awaiting your signature. Please check ' +
          'for a more recent email from us, or contact our team.',
      );
    }

    const result = await this.workflowService.recordAgreementSigned(
      application.id,
      borrowerActionOptions(
        params.ipAddress,
        `E-signed by the borrower as "${name}".`,
      ),
    );

    return this.fromAction(result, 'Your agreement is signed.');
  }

  /**
   * §6.1 `[borrower confirms amounts]`.
   *
   * The amounts are the proof of account ownership: only someone who can read
   * the account's transactions knows them. That is the entire security value of
   * the step, which is why a wrong answer costs an attempt rather than being
   * waved through.
   */
  async confirmVerificationDeposit(params: {
    token: string;
    ipAddress: string;
    amount1Cents: number;
    amount2Cents: number;
  }): Promise<BorrowerActionResponse> {
    const { applicationId, tokenId } = await this.tokenService.consume(
      params.token,
      'deposit_confirmation',
      params.ipAddress,
    );

    const application = await this.load(applicationId);

    if (
      application.status === ApplicationStatus.VERIFICATION_DEPOSIT_CONFIRMED ||
      application.micro_deposit_confirmed_at
    ) {
      return this.describe(application, 'Your deposits are confirmed.');
    }

    if (application.status !== ApplicationStatus.VERIFICATION_DEPOSIT_SENT) {
      await this.tokenService.release(tokenId);

      throw new BadRequestException(
        'This application is not waiting on a deposit confirmation. Please ' +
          'contact our team.',
      );
    }

    const expected1 = application.micro_deposit_amount_1_cents;
    const expected2 = application.micro_deposit_amount_2_cents;

    if (expected1 == null || expected2 == null) {
      /*
       * The deposit was sent before the amounts were recorded — only possible
       * for a file that predates this column. Failing loudly is right: silently
       * accepting whatever the borrower typed would confirm ownership of an
       * account nobody checked.
       */
      this.logger.error(
        `Application ${application.application_id} has no recorded ` +
          'micro-deposit amounts; cannot confirm.',
      );

      await this.tokenService.release(tokenId);

      throw new BadRequestException(
        'We could not check those amounts. Please contact our team so we can ' +
          'reissue your verification deposit.',
      );
    }

    if (application.micro_deposit_attempts >= MAX_DEPOSIT_ATTEMPTS) {
      throw new BadRequestException(
        'Too many incorrect attempts. Please contact our team and we will ' +
          'reissue your verification deposit.',
      );
    }

    /*
     * Order-insensitive: the borrower reads two lines off a statement and has
     * no way to know which we consider "first". Failing them for transposing
     * two numbers they read correctly would be a support ticket, not security.
     */
    const submitted = [params.amount1Cents, params.amount2Cents].sort(
      (a, b) => a - b,
    );
    const expected = [expected1, expected2].sort((a, b) => a - b);
    const matches =
      submitted[0] === expected[0] && submitted[1] === expected[1];

    if (!matches) {
      /*
       * Read the count before incrementing rather than trusting the instance
       * afterwards — whether Sequelize refreshes the in-memory value on
       * increment is a version detail, and telling a borrower they have one
       * more or one fewer try than they do is the kind of bug nobody reports.
       */
      const attemptsBefore = application.micro_deposit_attempts;

      await application.increment('micro_deposit_attempts');

      // The link survives a typo; only the attempt is spent.
      await this.tokenService.release(tokenId);

      const remaining = Math.max(
        0,
        MAX_DEPOSIT_ATTEMPTS - (attemptsBefore + 1),
      );

      throw new BadRequestException(
        `Those amounts do not match the deposits we sent. ${remaining} ` +
          `attempt${remaining === 1 ? '' : 's'} remaining.`,
      );
    }

    const result = await this.workflowService.confirmVerificationDeposit(
      application.id,
      borrowerActionOptions(
        params.ipAddress,
        'Micro-deposit amounts confirmed by the borrower.',
      ),
    );

    return this.fromAction(result, 'Your deposits are confirmed.');
  }

  private async load(applicationId: string): Promise<Application> {
    const application = await this.applicationModel.findByPk(applicationId);

    if (!application) {
      // The token's FK cascades on delete, so this is unreachable short of a
      // hand-edited database.
      throw new BadRequestException('This link is no longer valid.');
    }

    return application;
  }

  /*
   * Borrower-facing responses carry the reference and the step, and nothing
   * else. The full record holds the borrower's SSN and bank details, and these
   * endpoints are reached with a link that may sit in an email client's cache.
   */
  private describe(
    application: Application,
    message: string,
  ): BorrowerActionResponse {
    return {
      reference: application.application_id,
      status: application.status,
      message,
    };
  }

  private fromAction(
    result: ActionResult,
    message: string,
  ): BorrowerActionResponse {
    return {
      reference: result.application_id,
      status: result.status,
      message,
    };
  }
}

export interface BorrowerActionResponse {
  reference: string;
  status: ApplicationStatus;
  message: string;
}
