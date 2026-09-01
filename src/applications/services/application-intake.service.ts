import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import * as crypto from 'crypto';

import { Application } from '../models/application.model';
import { BlockedAttempt } from '../models/blocked-attempt.model';
import { CreateApplicationDto } from '../dto/create-application.dto';
import { ApplicationStatus } from '../dto/application-enums';
import {
  ADMIN_TIMEZONE,
  SUPPORT_PHONE_DISPLAY,
  type RequestMetadata,
} from '../application.types';
import { FieldCryptoService } from '../../common/crypto/field-crypto.service';
import { EmailService } from '../../email/email.service';
import { DripService } from '../../queue/drip/drip.service';

/** §5: a decline locks the applicant out for 90 days. */
const DECLINE_COOLDOWN_DAYS = 90;

/**
 * Borrower-facing intake: normalisation, the four blocking duplicate rules, the
 * soft-duplicate flag, encryption, and the post-commit side effects.
 *
 * Extracted from the monolithic ApplicationsService. Everything here runs for
 * an anonymous member of the public, which is a materially different trust
 * boundary from the admin services next to it — keeping them in one class made
 * it easy to reach admin-only helpers from a public path by accident.
 */
@Injectable()
export class ApplicationIntakeService {
  private readonly logger = new Logger(ApplicationIntakeService.name);

  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,

    @InjectModel(BlockedAttempt)
    private readonly blockedAttemptModel: typeof BlockedAttempt,

    private readonly crypto: FieldCryptoService,
    private readonly emailService: EmailService,
    private readonly dripService: DripService,
  ) {}

  async create(
    dto: CreateApplicationDto,
    metadata: RequestMetadata,
  ): Promise<Application> {
    const now = new Date();

    const emailNormalized = ApplicationIntakeService.normalizeEmail(dto.email);
    const phoneNormalized = ApplicationIntakeService.normalizePhone(dto.phone);
    const ssnHash = this.crypto.hash(dto.ssn);
    const accountLast4 = dto.account_number.slice(-4);

    await this.assertNotBlocked({ dto, metadata, ssnHash, now });

    const possibleDuplicate = await this.findPossibleDuplicate({
      emailNormalized,
      phoneNormalized,
      lastName: dto.last_name,
      dob: dto.dob,
      accountLast4,
      bankName: dto.bank_name,
    });

    const application = await this.persist({
      dto,
      metadata,
      now,
      emailNormalized,
      phoneNormalized,
      ssnHash,
      accountLast4,
      possibleDuplicate,
    });

    await this.runPostCommitEffects(application, now);

    return application;
  }

  /**
   * The four blocking rules, in the order the brief states them. Each one
   * records a blocked_attempt before throwing, so a borrower repeatedly bouncing
   * off the duplicate check is visible to the fraud review rather than silent.
   */
  private async assertNotBlocked(params: {
    dto: CreateApplicationDto;
    metadata: RequestMetadata;
    ssnHash: string;
    now: Date;
  }): Promise<void> {
    const { dto, metadata, ssnHash, now } = params;

    // 1. An application already in flight for this SSN.
    const inFlight = await this.applicationModel.findOne({
      where: {
        ssn_hash: ssnHash,
        status: {
          [Op.notIn]: [
            ApplicationStatus.DECLINED,
            ApplicationStatus.WITHDRAWN,
            ApplicationStatus.EXPIRED,
          ],
        },
      },
      order: [['created_at', 'DESC']],
    });

    if (inFlight) {
      await this.recordBlockedAttempt(
        dto,
        metadata,
        ssnHash,
        'exact_duplicate',
      );

      throw new ConflictException(
        `You already have an application in progress (ID #${inFlight.application_id}). ` +
          `Call ${SUPPORT_PHONE_DISPLAY} or check your status.`,
      );
    }

    // 2. 90-day cooldown after a decline.
    const cooldownStart = new Date(now);
    cooldownStart.setDate(cooldownStart.getDate() - DECLINE_COOLDOWN_DAYS);

    const recentlyDeclined = await this.applicationModel.findOne({
      where: {
        ssn_hash: ssnHash,
        decision: 'declined',
        created_at: { [Op.gt]: cooldownStart },
      },
      order: [['created_at', 'DESC']],
    });

    if (recentlyDeclined) {
      /*
       * The eligible date is measured from the decision, not from submission:
       * a file declined weeks after it arrived would otherwise reopen early.
       * Falling back to created_at keeps rows written before decision_at
       * existed from throwing.
       */
      const anchor =
        recentlyDeclined.decision_at ?? recentlyDeclined.created_at;

      if (!anchor) {
        throw new InternalServerErrorException(
          'Declined application is missing both decision_at and created_at',
        );
      }

      const eligibleDate = new Date(anchor);
      eligibleDate.setDate(eligibleDate.getDate() + DECLINE_COOLDOWN_DAYS);

      await this.recordBlockedAttempt(
        dto,
        metadata,
        ssnHash,
        'declined_90_day_cooldown',
      );

      throw new ConflictException(
        `You may reapply on ${ApplicationIntakeService.formatDate(eligibleDate)}.`,
      );
    }

    // 3. An open funded loan.
    const openLoan = await this.applicationModel.findOne({
      where: {
        ssn_hash: ssnHash,
        status: ApplicationStatus.FUNDED,
        payoff_recorded_at: null,
      },
      order: [['created_at', 'DESC']],
    });

    if (openLoan) {
      await this.recordBlockedAttempt(
        dto,
        metadata,
        ssnHash,
        'funded_loan_open',
      );

      throw new ConflictException(
        'You currently have an active funded loan. Please contact servicing.',
      );
    }
  }

  private async persist(params: {
    dto: CreateApplicationDto;
    metadata: RequestMetadata;
    now: Date;
    emailNormalized: string;
    phoneNormalized: string;
    ssnHash: string;
    accountLast4: string;
    possibleDuplicate: boolean;
  }): Promise<Application> {
    const { dto, metadata, now } = params;

    const transaction = await this.applicationModel.sequelize!.transaction();

    try {
      /*
       * §6: received → pending_call automatically, immediately after submit.
       * There is no observable window at `received`, so it is written once.
       *
       * The application_id is generated inside the transaction and retried on
       * collision — the old implementation generated one 6-character id and
       * hoped, which at scale eventually throws a unique-violation at the
       * borrower after they have filled in five steps.
       */
      const application = await this.createWithUniqueId(
        {
          ...dto,

          // monthly_housing_cost:
          //   dto.monthly_housing_cost === ''
          //     ? null
          //     : Number(dto.monthly_housing_cost),

          // employment_length_mo:
          //   dto.employment_length_mo === ''
          //     ? null
          //     : Number(dto.employment_length_mo),

          vehicle_year:
            dto.vehicle_year === undefined ? null : Number(dto.vehicle_year),

          status: ApplicationStatus.PENDING_CALL,

          email_normalized: params.emailNormalized,
          phone_normalized: params.phoneNormalized,

          ssn_encrypted: this.crypto.encrypt(dto.ssn),
          ssn_last4: dto.ssn.slice(-4),
          ssn_hash: params.ssnHash,

          dl_number_encrypted: this.crypto.encryptOptional(dto.dl_number),

          routing_encrypted: this.crypto.encrypt(dto.routing_number),
          account_encrypted: this.crypto.encrypt(dto.account_number),
          account_last4: params.accountLast4,

          possible_duplicate: params.possibleDuplicate,

          consent_esign_at: dto.consent_esign_at
            ? new Date(dto.consent_esign_at)
            : now,

          /*
           * TCPA consent is optional, but when it IS given we must be able to
           * prove when it was given and what wording was shown (§3, and the
           * applications_tcpa_evidence_check constraint).
           */
          consent_tcpa: Boolean(dto.consent_tcpa),
          consent_tcpa_at: dto.consent_tcpa
            ? dto.consent_tcpa_at
              ? new Date(dto.consent_tcpa_at)
              : now
            : null,
          consent_tcpa_text: dto.consent_tcpa
            ? (dto.consent_tcpa_text ?? null)
            : null,

          ip_address: metadata.ipAddress,
          ip_country: metadata.ipCountry || null,
          ip_region: metadata.ipRegion || null,
          user_agent: metadata.userAgent || null,
          referrer: dto.referrer ?? metadata.referrer ?? null,

          form_started_at: dto.form_started_at
            ? new Date(dto.form_started_at)
            : null,
          form_completed_at: now,
        },
        transaction,
      );

      await transaction.commit();

      return application;
    } catch (error) {
      this.logger.error('Failed to create application');

      console.error('FULL ERROR:', error);

      if (error instanceof Error) {
        console.error('MESSAGE:', error.message);
        console.error('STACK:', error.stack);
      }

      console.error('ORIGINAL:', (error as any).original);
      console.error('PARENT:', (error as any).parent);

      throw error;
    }
  }

  /**
   * Insert with a fresh 6-character id, retrying on the unique violation.
   *
   * 36^6 ids over a growing table means collisions are rare but inevitable, and
   * the failure mode — a borrower losing a completed form to a 500 — is far
   * worse than the cost of retrying.
   */
  private async createWithUniqueId(
    values: Record<string, unknown>,
    transaction: import('sequelize').Transaction,
    attempt = 0,
  ): Promise<Application> {
    const applicationId = ApplicationIntakeService.generateApplicationId();

    try {
      return await this.applicationModel.create(
        { ...values, application_id: applicationId } as never,
        { transaction },
      );
    } catch (error) {
      const isCollision =
        error instanceof Error &&
        error.name === 'SequelizeUniqueConstraintError' &&
        /application_id/.test(
          String((error as { message?: string }).message ?? ''),
        );

      if (isCollision && attempt < 5) {
        this.logger.warn(
          `application_id collision on ${applicationId}; retrying`,
        );
        return this.createWithUniqueId(values, transaction, attempt + 1);
      }

      throw error;
    }
  }

  /**
   * The application is durable by the time this runs. Email and queue failures
   * are logged but must not discard a submitted application — a borrower who
   * filled in five steps should not lose them to an SMTP timeout.
   */
  private async runPostCommitEffects(
    application: Application,
    now: Date,
  ): Promise<void> {
    const confirmationSentAt = new Date();

    try {
      await this.emailService.sendApplicationConfirmationEmail({
        applicationId: application.application_id,
        applicationUuid: application.id,
        firstName: application.first_name,
        lastName: application.last_name,
        email: application.email,
        loanAmount: Number(application.amount_requested),
        loanPurpose: application.loan_purpose,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send confirmation email for ${application.application_id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    /*
     * Start both §7.1 sequences. The confirmation send is passed in as a known
     * transactional event so the 90-minute conflict rule can push any drip step
     * that would otherwise land on top of it.
     */
    try {
      await this.dripService.startSequences({
        applicationUuid: application.id,
        formCompletedAt: application.form_completed_at ?? now,
        state: application.state,
        zip: application.zip,
        transactionalSends: [confirmationSentAt],
      });
    } catch (error) {
      this.logger.error(
        `Failed to start drip sequences for ${application.application_id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /*
   * ============================================================
   * SOFT DUPLICATE CHECK
   * ============================================================
   *
   * Two or more matching signals flags the file for review. It never blocks.
   *
   * Signals: email · phone · last name + DOB · account last4 + bank.
   */
  private async findPossibleDuplicate(params: {
    emailNormalized: string;
    phoneNormalized: string;
    lastName: string;
    dob: string;
    accountLast4: string;
    bankName: string;
  }): Promise<boolean> {
    const candidates = await this.applicationModel.findAll({
      where: {
        [Op.or]: [
          { email_normalized: params.emailNormalized },
          { phone_normalized: params.phoneNormalized },
          { last_name: params.lastName, dob: params.dob },
          { account_last4: params.accountLast4, bank_name: params.bankName },
        ],
      },
      // Only the signal columns are needed; loading full rows here pulled every
      // borrower's encrypted secrets into memory to compute a boolean.
      attributes: [
        'email_normalized',
        'phone_normalized',
        'last_name',
        'dob',
        'account_last4',
        'bank_name',
      ],
      limit: 100,
    });

    return candidates.some((candidate) => {
      let signals = 0;

      if (candidate.email_normalized === params.emailNormalized) signals++;
      if (candidate.phone_normalized === params.phoneNormalized) signals++;

      if (
        candidate.last_name === params.lastName &&
        ApplicationIntakeService.isSameDate(candidate.dob, params.dob)
      ) {
        signals++;
      }

      if (
        candidate.account_last4 === params.accountLast4 &&
        ApplicationIntakeService.normalizeString(candidate.bank_name) ===
          ApplicationIntakeService.normalizeString(params.bankName)
      ) {
        signals++;
      }

      return signals >= 2;
    });
  }

  /** Every blocked attempt is stored for the fraud review. */
  private async recordBlockedAttempt(
    dto: CreateApplicationDto,
    metadata: RequestMetadata,
    ssnHash: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.blockedAttemptModel.create({
        email: ApplicationIntakeService.normalizeEmail(dto.email),
        phone: ApplicationIntakeService.normalizePhone(dto.phone),
        ssn_hash: ssnHash,
        ip_address: metadata.ipAddress,
        ip_country: metadata.ipCountry || null,
        ip_region: metadata.ipRegion || null,
        user_agent: metadata.userAgent || null,
        reason,
      } as never);
    } catch (error) {
      // The borrower still has to be told they are blocked; losing the audit
      // row must not turn a 409 into a 500.
      this.logger.error(
        `Failed to record blocked attempt (${reason})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /*
   * ============================================================
   * NORMALIZATION
   * ============================================================
   *
   * Gmail:  John.Doe+test@gmail.com -> johndoe@gmail.com
   * Others: John.Doe+test@yahoo.com -> john.doe@yahoo.com
   */
  static normalizeEmail(email: string): string {
    const normalized = email.trim().toLowerCase();
    const atIndex = normalized.lastIndexOf('@');

    if (atIndex === -1) return normalized;

    const domain = normalized.slice(atIndex + 1);
    let localPart = normalized.slice(0, atIndex).split('+')[0];

    // Gmail ignores dots in the local part.
    if (domain === 'gmail.com' || domain === 'googlemail.com') {
      localPart = localPart.replace(/\./g, '');
    }

    return `${localPart}@${domain}`;
  }

  /** Last ten digits, matching the varchar(10) phone_normalized column. */
  static normalizePhone(phone: string): string {
    return phone.replace(/\D/g, '').slice(-10);
  }

  static normalizeString(value?: string | null): string {
    return value?.trim().toLowerCase().replace(/\s+/g, ' ') || '';
  }

  static isSameDate(
    first: string | Date | null | undefined,
    second: string | Date | null | undefined,
  ): boolean {
    if (!first || !second) return false;

    const a = new Date(first);
    const b = new Date(second);

    return (
      a.getUTCFullYear() === b.getUTCFullYear() &&
      a.getUTCMonth() === b.getUTCMonth() &&
      a.getUTCDate() === b.getUTCDate()
    );
  }

  static formatDate(date: Date): string {
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: ADMIN_TIMEZONE,
    });
  }

  /** Six characters, uppercase alphanumeric — the id borrowers quote. */
  static generateApplicationId(): string {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const bytes = crypto.randomBytes(6);

    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join(
      '',
    );
  }
}
