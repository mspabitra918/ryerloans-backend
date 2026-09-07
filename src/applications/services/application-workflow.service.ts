import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import * as crypto from 'crypto';

import { Application } from '../models/application.model';
import { ApplicationStatus } from '../dto/application-enums';
import { DocumentRequest } from '../../documents/models/document-request.model';
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  ECOA_REASON_CODES,
  borrowerActionOptions,
  requireAdminId,
  type AdminActionOptions,
  type DocumentType,
} from '../application.types';
import { BorrowerActionTokenService } from './borrower-action-token.service';
import { assertTransition, isTerminal } from '../application-status.machine';
import {
  EmailService,
  hasStatusTemplate,
  type SendEmailResult,
} from '../../email/email.service';
import { reviewUrl } from '../../email/brand.constants';
import { ReviewInvitationService } from '../../review-invitation/review-invitations.service';
import { EmailLogService } from '../../email-log/email-log.service';
import { DripService } from '../../queue/drip/drip.service';
import {
  DripEmailService,
  hasDripTemplate,
} from '../../queue/drip/drip-email.service';
import { sequencesCancelledBy } from '../../queue/drip/drip.constants';
import {
  AuditLogService,
  type AuditAction,
} from '../../audit-log/audit-log.service';
import { ApplicationDetailService } from './application-detail.service';
import type { AuthenticatedAdmin } from '../../auth/auth.types';

/** §5: a decline locks the applicant out for 90 days. */
const DECLINE_COOLDOWN_DAYS = 90;

/** How long a borrower has to use a document upload link. */
const DOCUMENT_LINK_TTL_DAYS = 30;

/**
 * Live states a file can still be moved into bank_verification_pending from.
 *
 * Both §6.1 edges into that state start here: in_review (after "Mark as Called
 * In") and pending_call (the bypass, for the borrower who verifies off the
 * day-0 drip without calling in).
 */
const PRE_VERIFICATION_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.PENDING_CALL,
  ApplicationStatus.IN_REVIEW,
];

export interface ActionResult {
  id: string;
  application_id: string;
  status: ApplicationStatus;
  email_sent: boolean;
  email_withheld_reason?: string;
}

/** Distinguishes a primary key from the six-character public reference. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The §8.4 action buttons and the §6 state machine behind them.
 *
 * Each button follows the same four beats — check the precondition, write the
 * state, audit it, then run the side effects — so they are expressed through
 * one `runAction` helper instead of nine near-identical copies. The copies were
 * the reason `markAsCalledIn` and `fundApplication` had drifted into recording
 * their audit rows differently.
 */
@Injectable()
export class ApplicationWorkflowService {
  private readonly logger = new Logger(ApplicationWorkflowService.name);

  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    @InjectModel(DocumentRequest)
    private readonly documentRequestModel: typeof DocumentRequest,
    private readonly emailService: EmailService,
    private readonly emailLogService: EmailLogService,
    private readonly dripService: DripService,
    private readonly dripEmailService: DripEmailService,
    private readonly auditLogService: AuditLogService,
    private readonly detailService: ApplicationDetailService,
    private readonly tokenService: BorrowerActionTokenService,
    private readonly reviewInvitationService: ReviewInvitationService,
  ) {}

  /* --------------------------------------------------------------- generic */

  /**
   * Statuses that are only reachable through their own action, never through
   * the generic status change.
   *
   * Each carries obligations the §6 transition table knows nothing about:
   * `declined` needs ECOA reason codes and an adverse action notice, `approved`
   * needs the term, APR and payment, and `funded` needs the disbursement amount
   * and the typed Application ID. Reaching them through here produced a file in
   * a decision state with none of that recorded — a decline with no principal
   * reasons is a Regulation B violation, not a status typo.
   */
  private static readonly DEDICATED_ACTION_STATUSES: Readonly<
    Partial<Record<ApplicationStatus, string>>
  > = {
    [ApplicationStatus.DECLINED]: 'Decline',
    [ApplicationStatus.APPROVED]: 'Approve',
    [ApplicationStatus.FUNDED]: 'Fund',
  };

  async updateStatus(
    applicationId: string,
    status: ApplicationStatus,
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const dedicated =
      ApplicationWorkflowService.DEDICATED_ACTION_STATUSES[status];

    if (dedicated) {
      throw new BadRequestException(
        `"${status}" cannot be set directly — use the ${dedicated} action, ` +
          'which records the terms and notices that status requires.',
      );
    }

    const application = await this.findOrFail(applicationId);
    const previous = application.status;

    assertTransition(previous, status);

    return this.runAction({
      application,
      action: 'status_change',
      options,
      apply: (record) => {
        record.status = status;
      },
      audit: { field: 'status', oldValue: previous, newValue: status },
    });
  }

  /* ------------------------------------------------------- §8.4 Called In */

  async markAsCalledIn(
    applicationId: string,
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    if (application.status !== ApplicationStatus.PENDING_CALL) {
      throw new BadRequestException(
        `Application must be pending_call. Current status: ${application.status}`,
      );
    }

    /*
     * The call is what unblocks bank verification, so this button takes the
     * §6.1 branch from pending_call straight to bank_verification_pending: the
     * borrower has already been receiving Plaid links from the day-0 drip
     * (§7.1), and the file should describe the step they are actually on.
     *
     * Known discrepancy, recorded deliberately: the §8.4 button table says
     * this action "advances to in_review". The §6.1 diagram draws two edges
     * out of pending_call and is ambiguous about which one carries the button
     * label. This follows the diagram; reverting means changing this one line
     * back to IN_REVIEW, which is still a legal transition.
     *
     * `in_review` remains reachable — it is where a file sits when the
     * borrower never calls, with the 3-day no-call sequence running — and it
     * still steps forward to bank_verification_pending.
     *
     * The email is `call_confirmed`, not a status notice: what the borrower
     * needs to read is that their call landed and that the reminders stopped.
     */
    /*
     * The call is what unblocks verification, so the "thanks for calling" email
     * carries the link for the step the borrower now lands on. Without it that
     * email drops its CTA entirely: the wrapper only renders the button when a
     * link was minted, and the file is in bank_verification_pending by the time
     * it sends.
     *
     * This supersedes the outstanding link, and the §7.1 drip will supersede it
     * again on its next reminder. That is the intended behaviour — the newest
     * email always holds the working link.
     */
    const link = await this.tokenService.issue(
      application.id,
      'bank_verification',
    );

    return this.runAction({
      application,
      action: 'mark_called_in',
      options,
      emailTemplateKey: 'call_confirmed',
      actionUrl: link.url,
      apply: (record) => {
        record.called_in = true;
        record.called_in_at = new Date();
        record.called_in_by_admin = requireAdminId(options);
        record.status = ApplicationStatus.BANK_VERIFICATION_PENDING;
      },
      audit: { field: 'called_in', oldValue: false, newValue: true },
      /*
       * The call-in sequence is cancelled by `called_in` regardless of status
       * (§7.2), so cancel it explicitly rather than relying on the status rule.
       */
      extraCancellations: { trigger: 'called_in', sequences: ['call_in'] },
    });
  }

  /* ------------------------------------------------- §8.4 Bank verification */

  /**
   * §8.4 "Send Bank Verification" — issues a fresh Plaid link.
   *
   * The link itself is minted by the borrower-facing verification flow; this
   * records the request, notifies the borrower, and leaves the file in
   * bank_verification_pending so the §7 reminder drip keeps running.
   */
  async sendBankVerification(
    applicationId: string,
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    if (application.bank_verified) {
      throw new BadRequestException('Bank account is already verified');
    }

    if (isTerminal(application.status)) {
      throw new BadRequestException(
        `Cannot request bank verification on a ${application.status} application`,
      );
    }

    /*
     * §8.4: "Generates fresh Plaid link". Fresh is the operative word — issuing
     * revokes any outstanding bank-verification link, so a link sent to an
     * address the borrower has since corrected stops working.
     */
    const link = await this.tokenService.issue(
      application.id,
      'bank_verification',
    );

    return this.runAction({
      application,
      action: 'send_bank_verification',
      options,
      emailTemplateKey: 'bank_verification_requested',
      actionUrl: link.url,
      apply: (record) => {
        /*
         * Only advance a file that has not started verification yet; re-sending
         * to one already in the pending state must not rewind anything.
         *
         * pending_call counts as "not started" too — that is the §6.1 bypass
         * edge, for the borrower who verifies off the day-0 drip without ever
         * calling in. Skipping it here left the button sending the email and
         * silently leaving the status behind.
         */
        if (PRE_VERIFICATION_STATUSES.includes(record.status)) {
          record.status = ApplicationStatus.BANK_VERIFICATION_PENDING;
        }
      },
      audit: { field: 'bank_verification_requested_at', newValue: new Date() },
    });
  }

  /**
   * Record a successful bank verification (Plaid webhook, or an admin
   * confirming out of band).
   */
  async recordBankVerified(
    applicationId: string,
    params: {
      plaidItemId?: string | null;
      /** Omit for the borrower's own Plaid success; see below. */
      options?: AdminActionOptions;
      ipAddress?: string;
    },
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    /*
     * Anything at or before bank_verification_pending is fair game. Pinning
     * this to bank_verification_pending alone rejected a real Plaid success:
     * the §7.1 bank verification drip mails the link on day 0, so a borrower
     * can finish verifying while the file is still pending_call and no admin
     * has pressed "Send Bank Verification". Refusing to record a verification
     * we actually obtained is the worse failure.
     */
    const pending =
      application.status === ApplicationStatus.BANK_VERIFICATION_PENDING;

    if (!pending && !PRE_VERIFICATION_STATUSES.includes(application.status)) {
      throw new BadRequestException(
        `Application must be at or before bank_verification_pending. ` +
          `Current status: ${application.status}`,
      );
    }

    /*
     * §6.1 draws the [Plaid success — auto] edge out of bank_verification_pending
     * and nowhere else. Walk a file that skipped that state through it rather
     * than jumping two steps — otherwise the history records a hop the state
     * machine would reject, which is exactly what makes an audit trail useless.
     */
    if (!pending) {
      assertTransition(
        application.status,
        ApplicationStatus.BANK_VERIFICATION_PENDING,
      );
      application.status = ApplicationStatus.BANK_VERIFICATION_PENDING;
      await application.save();
    }

    /*
     * With no admin supplied this is the borrower's own Plaid success. It used
     * to borrow `called_in_by_admin` as the actor and skip the audit entirely
     * when that was empty — attributing the borrower's action to an employee,
     * or losing it. audit_log.admin_user_id is nullable now, so the row can say
     * what actually happened.
     */
    const options: AdminActionOptions =
      params.options ?? borrowerActionOptions(params.ipAddress ?? '0.0.0.0');

    return this.runAction({
      application,
      action: 'status_change',
      options,
      apply: (record) => {
        record.bank_verified = true;
        record.bank_verified_at = new Date();
        record.plaid_item_id = params.plaidItemId ?? record.plaid_item_id;
        record.status = ApplicationStatus.BANK_VERIFICATION_COMPLETE;
      },
      audit: { field: 'bank_verified', oldValue: false, newValue: true },
      /*
       * §7.2: `bank_verified` is itself a cancellation trigger, so tear the
       * queued steps down here rather than leaving them to cancel themselves
       * when each job wakes up.
       */
      extraCancellations: { trigger: 'bank_verified', sequences: undefined },
    });
  }

  /* -------------------------------------------------- §8.4 Request Documents */

  /**
   * §8.4 "Request Documents" — checklist modal, generates an upload link.
   *
   * The token is returned once, to be embedded in the borrower's email; only
   * its SHA-256 is stored, so the link cannot be recovered from the database.
   */
  async requestDocuments(
    applicationId: string,
    params: { docTypes: string[]; note?: string; options: AdminActionOptions },
  ): Promise<ActionResult & { upload_url: string; expires_at: Date }> {
    const application = await this.findOrFail(applicationId);

    const invalid = params.docTypes.filter(
      (type) => !(DOCUMENT_TYPES as readonly string[]).includes(type),
    );

    if (params.docTypes.length === 0) {
      throw new BadRequestException('Select at least one document to request');
    }

    if (invalid.length > 0) {
      throw new BadRequestException(
        `Unknown document types: ${invalid.join(', ')}. ` +
          `Allowed: ${DOCUMENT_TYPES.join(', ')}`,
      );
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + DOCUMENT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.documentRequestModel.create({
      application_id: application.id,
      requested_by: requireAdminId(params.options),
      doc_types: params.docTypes,
      token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      expires_at: expiresAt,
      note: params.note ?? null,
    });

    const result = await this.runAction({
      application,
      action: 'request_documents',
      options: params.options,
      emailTemplateKey: 'documents_requested',
      apply: (record) => {
        record.documents_requested_at = new Date();
        record.documents_requested_types = params.docTypes;
      },
      audit: { field: 'documents_requested_types', newValue: params.docTypes },
      // There is no status-update template for a document request; the borrower
      // gets a purpose-built email instead.
      sendStatusEmail: false,
      customEmail: (record) =>
        this.emailService.sendEmail({
          to: record.email,
          subject: `Documents needed for application #${record.application_id}`,
          html: this.documentRequestEmailHtml(
            record,
            params.docTypes as DocumentType[],
            `${this.borrowerBaseUrl()}/documents/${token}`,
            expiresAt,
          ),
          templateKey: 'documents_requested',
          applicationId: record.id,
          transactional: true,
        }),
    });

    console.log(
      `Document request for ${application.application_id}: ${this.borrowerBaseUrl()}/documents/${token}`,
    );

    return {
      ...result,
      upload_url: `${this.borrowerBaseUrl()}/documents/${token}`,
      expires_at: expiresAt,
    };
  }

  /* --------------------------------------------------- §8.4 Edit Application */

  /**
   * §8.4 "Edit Application" — the editable form, with every field change logged
   * old→new against the admin and a timestamp, and `application_updated` sent
   * only when a borrower-visible field actually moved.
   *
   * The diff, the permission rules and the audit rows belong to the detail
   * service, which owns the field vocabulary. What is added here is the half
   * §8.4 shares with every other button: the borrower email, the "do not send"
   * override with its mandatory reason, and the edited-copy audit entry.
   *
   * No drip sequences are torn down: an edit is not a state transition, and
   * correcting a typo in an employer name must not silence the reminders the
   * borrower is still waiting on.
   */
  async editApplication(params: {
    applicationId: string;
    admin: AuthenticatedAdmin;
    changes: Record<string, unknown>;
    password?: string;
    options: AdminActionOptions;
  }): Promise<
    ActionResult & {
      changed_fields: string[];
      borrower_visible_change: boolean;
    }
  > {
    const { application, changed, borrowerVisibleChange } =
      await this.detailService.edit({
        applicationId: params.applicationId,
        admin: params.admin,
        changes: params.changes,
        note: params.options.note,
        password: params.password,
      });

    const base = {
      id: application.id,
      application_id: application.application_id,
      status: application.status,
      changed_fields: changed.map((change) => change.field),
      borrower_visible_change: borrowerVisibleChange,
    };

    /*
     * §8.4 qualifies this one email with "(if borrower-visible field changed)".
     * An internal correction — an employer phone, a balance band — is audited
     * but not mailed, so the borrower is not woken up by every keystroke an
     * underwriter makes on their file.
     */
    if (!borrowerVisibleChange) {
      return {
        ...base,
        email_sent: false,
        email_withheld_reason: 'no_borrower_visible_field_changed',
      };
    }

    const outcome = await this.deliverBorrowerEmail({
      application,
      status: application.status,
      templateKey: 'application_updated',
      options: params.options,
    });

    return { ...base, ...outcome };
  }

  /* --------------------------------------------------- §8.4 Agreement / deposit */

  async sendLoanAgreement(
    applicationId: string,
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    /*
     * Also callable from agreement_sent: that is a re-send, for the borrower
     * whose link expired or never arrived. Nothing else moves a file out of
     * agreement_sent but the borrower's own signature, so without this an admin
     * watching an unsigned agreement had no way to put a live link back in
     * their hands.
     *
     * issue() revokes the outstanding token first, so the superseded link stops
     * working the moment a new one is sent.
     */
    const resend = application.status === ApplicationStatus.AGREEMENT_SENT;

    if (!resend) {
      this.requireStatus(
        application,
        ApplicationStatus.BANK_VERIFICATION_COMPLETE,
      );
    }

    // §8.4: "Generates agreement at approved terms, sends e-sign link."
    const link = await this.tokenService.issue(
      application.id,
      'agreement_signature',
    );

    const sentAt = new Date();

    return this.runAction({
      application,
      action: 'send_loan_agreement',
      options,
      actionUrl: link.url,
      apply: (record) => {
        record.status = ApplicationStatus.AGREEMENT_SENT;

        /*
         * First send only. The §8.4 timeline reads agreement_sent_at as "when
         * the agreement went out", and stamping it again on every re-send would
         * walk that entry forward and lose the date the borrower was actually
         * first asked to sign. The re-send is in the audit log either way.
         */
        record.agreement_sent_at ??= sentAt;
      },
      /*
       * A re-send changes no field, so it logs the action and the time it
       * happened rather than a field diff whose old and new values are the
       * same date.
       */
      audit: resend ? {} : { field: 'agreement_sent_at', newValue: sentAt },
    });
  }

  /** Borrower e-signature callback. */
  async recordAgreementSigned(
    applicationId: string,
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    this.requireStatus(application, ApplicationStatus.AGREEMENT_SENT);

    return this.runAction({
      application,
      action: 'status_change',
      options,
      apply: (record) => {
        record.status = ApplicationStatus.AGREEMENT_SIGNED;
        record.agreement_signed_at = new Date();
      },
      audit: { field: 'agreement_signed_at', newValue: new Date() },
    });
  }

  /**
   * §8.4 "Send Verification Deposit" — records the micro-deposit initiation.
   *
   * The two amounts are what the borrower is later asked to reproduce, so they
   * are recorded here rather than inferred: §0.3 is explicit that this step is
   * Ryer sending money to prove account ownership, and an unrecorded amount
   * makes the confirmation unverifiable.
   */
  async sendVerificationDeposit(
    applicationId: string,
    params: { amount1Cents: number; amount2Cents: number },
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    this.requireStatus(application, ApplicationStatus.AGREEMENT_SIGNED);

    for (const [label, cents] of [
      ['first', params.amount1Cents],
      ['second', params.amount2Cents],
    ] as const) {
      /*
       * Micro-deposits are pennies by definition. A three-figure "micro"
       * deposit is a fat-fingered amount field, and it is real money leaving
       * the account before anyone notices.
       */
      if (!Number.isInteger(cents) || cents < 1 || cents > 99) {
        throw new BadRequestException(
          `The ${label} verification deposit must be a whole number of cents ` +
            `between 1 and 99. Received: ${cents}.`,
        );
      }
    }

    const link = await this.tokenService.issue(
      application.id,
      'deposit_confirmation',
    );

    return this.runAction({
      application,
      action: 'send_verification_deposit',
      options,
      actionUrl: link.url,
      apply: (record) => {
        record.status = ApplicationStatus.VERIFICATION_DEPOSIT_SENT;
        record.micro_deposit_sent_at = new Date();
        record.micro_deposit_amount_1_cents = params.amount1Cents;
        record.micro_deposit_amount_2_cents = params.amount2Cents;
        // A re-send starts the borrower's attempt allowance over.
        record.micro_deposit_attempts = 0;
      },
      /*
       * The amounts themselves are not audited in the clear. audit_log hashes
       * old/new values, but the field name would still advertise which column
       * to go read, and the whole security value of the step is that only the
       * account holder can see them.
       */
      audit: { field: 'micro_deposit_sent_at', newValue: new Date() },
    });
  }

  /**
   * Borrower confirmed the micro-deposit amounts.
   *
   * Advances straight into underwriting: §6.1 draws that arrow with no admin
   * label, and a confirmed deposit is the last borrower-side step before a
   * human decision, so nothing is waiting on a button.
   */
  async confirmVerificationDeposit(
    applicationId: string,
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    this.requireStatus(
      application,
      ApplicationStatus.VERIFICATION_DEPOSIT_SENT,
    );

    const confirmedAt = new Date();

    /*
     * Write the confirmation as its own committed step before advancing. The
     * file genuinely passes through verification_deposit_confirmed, and the
     * public tracker (§6.2) reads micro_deposit_confirmed_at — recording both
     * in one hop would leave a transition the state machine rejects sitting in
     * the history.
     */
    application.status = ApplicationStatus.VERIFICATION_DEPOSIT_CONFIRMED;
    application.micro_deposit_confirmed_at = confirmedAt;
    application.micro_deposit_conf_at = confirmedAt;
    await application.save();

    return this.runAction({
      application,
      action: 'status_change',
      options,
      /*
       * The borrower is told their deposit was confirmed, not that the file
       * reached underwriting — the confirmation is the event they took part in.
       */
      emailStatus: ApplicationStatus.VERIFICATION_DEPOSIT_CONFIRMED,
      apply: (record) => {
        record.status = ApplicationStatus.UNDERWRITING;
      },
      audit: { field: 'micro_deposit_confirmed_at', newValue: confirmedAt },
    });
  }

  /* ------------------------------------------------------ §8.4 Decisioning */

  async approve(
    applicationId: string,
    params: { termMonths: number; apr: number; amount?: number },
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    this.requireStatus(application, ApplicationStatus.UNDERWRITING);

    if (params.termMonths <= 0) {
      throw new BadRequestException('Approved term must be at least one month');
    }

    if (params.apr < 0) {
      throw new BadRequestException('Approved APR cannot be negative');
    }

    return this.runAction({
      application,
      action: 'approve',
      options,
      apply: (record) => {
        record.status = ApplicationStatus.APPROVED;
        record.decision = 'approved';
        record.decision_at = new Date();
        record.approved_term_months = params.termMonths;
        record.approved_apr = params.apr;

        // §8.4 "Approve — Sets terms (amount, APR, term, payment)". A
        // counter-offer for less than the borrower asked for is a normal
        // underwriting outcome and must be recordable.
        if (params.amount !== undefined) {
          record.amount_requested = params.amount;
        }
      },
      audit: {
        field: 'decision',
        oldValue: null,
        newValue: {
          decision: 'approved',
          term_months: params.termMonths,
          apr: params.apr,
          amount: params.amount ?? Number(application.amount_requested),
        },
      },
    });
  }

  /**
   * §8.4 Decline — "Requires selecting ECOA reason codes before submit".
   *
   * NOTE: the email sent here is a courtesy status notice, NOT the ECOA adverse
   * action notice §7.3 requires (specific principal reasons, ECOA notice text,
   * CRA name/address/phone, right to a free report copy, right to dispute —
   * within 30 days). That template still needs to be written and reviewed by
   * counsel before this endpoint is used in production. The reference number
   * and reapply date recorded here are what that notice will quote.
   */
  async decline(
    applicationId: string,
    reasonCodes: string[],
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    /*
     * Declinable from `underwriting` only, per the §6.1 diagram, which branches
     * to declined from the decision step and from nowhere else. A file that
     * needs an ECOA notice before it gets that far — an unserved state of
     * residence, a bank account that cannot be verified — has to be walked to
     * underwriting first; see the note on UNIVERSAL_EXITS in
     * application-status.machine.ts.
     *
     * Approved is refused too: an offer already extended is rescinded, not
     * declined, and assertTransition says so.
     */
    assertTransition(application.status, ApplicationStatus.DECLINED);

    if (!reasonCodes?.length) {
      throw new BadRequestException(
        'At least one ECOA reason code is required.',
      );
    }

    const unknown = reasonCodes.filter((code) => !ECOA_REASON_CODES[code]);

    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown ECOA reason codes: ${unknown.join(', ')}`,
      );
    }

    const now = new Date();
    const reapplyDate = new Date(now);
    reapplyDate.setDate(reapplyDate.getDate() + DECLINE_COOLDOWN_DAYS);

    return this.runAction({
      application,
      action: 'decline',
      options,
      apply: (record) => {
        record.status = ApplicationStatus.DECLINED;
        record.decision = 'declined';
        record.decision_at = now;
        record.decline_reason_codes = reasonCodes;
        record.adverse_action_reference = `AA-${record.application_id}-${now
          .toISOString()
          .slice(0, 10)
          .replace(/-/g, '')}`;
        record.reapply_eligible_date = reapplyDate.toISOString().slice(0, 10);
      },
      audit: {
        field: 'decline_reason_codes',
        oldValue: null,
        newValue: reasonCodes,
      },
    });
  }

  async fund(
    applicationId: string,
    fundedAmount: number,
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    this.requireStatus(application, ApplicationStatus.APPROVED);

    if (!fundedAmount || fundedAmount <= 0) {
      throw new BadRequestException('Funded amount must be greater than 0.');
    }

    const approvedAmount = Number(application.amount_requested);

    // Funding more than was approved is a control failure, not a typo to wave
    // through — the approval is the authority for the disbursement.
    if (fundedAmount > approvedAmount) {
      throw new BadRequestException(
        `Funded amount (${fundedAmount}) exceeds the approved amount ` +
          `(${approvedAmount}). Re-approve at the higher amount first.`,
      );
    }

    return this.runAction({
      application,
      action: 'fund',
      options,
      emailLoanAmount: fundedAmount,
      apply: (record) => {
        record.status = ApplicationStatus.FUNDED;
        record.funded_at = new Date();
        record.funded_amount = fundedAmount;
      },
      audit: { field: 'funded_amount', oldValue: null, newValue: fundedAmount },
    });
  }

  /* --------------------------------------------- §8.4 Review invitation */

  /**
   * "Send Review Invitation" — the one thing left to do on a funded file.
   *
   * Funded is a terminal state, so this is deliberately not a transition: it
   * mints a review token, mails the borrower a link to the public form, and
   * leaves the file exactly where it is. The status check is the guard that
   * matters — §0 ties a review to a borrower who actually received money, and
   * an invitation sent from any other state produces exactly the kind of
   * unverified testimonial the moderation queue exists to keep off the site.
   *
   * Re-sending is allowed and supersedes the previous link (a 30-day token
   * expires, and a bounced email leaves nothing to click). Re-sending after
   * the borrower has already reviewed is not — the service refuses that.
   */
  async sendReviewInvitation(
    applicationId: string,
    options: AdminActionOptions,
  ): Promise<ActionResult & { review_url: string; expires_at: Date }> {
    const application = await this.findOrFail(applicationId);

    this.requireStatus(application, ApplicationStatus.FUNDED);

    const { invitation, reissued } =
      await this.reviewInvitationService.issueForApplication(application.id);

    const url = reviewUrl(invitation.token);
    console.log(`Review invitation for ${application.application_id}: ${url}`);

    const result = await this.runAction({
      application,
      action: 'send_review_invitation',
      options,
      // Nothing on the application moves — the invitation is its own record.
      apply: () => undefined,
      audit: {
        field: 'review_invitation_sent_at',
        oldValue: reissued ? 'reissued' : null,
        newValue: invitation.sent_at,
      },
      /*
       * Not a status notice: `funded` already has a template and it announces
       * the disbursement. Sending that one again would tell a borrower their
       * loan had been funded twice.
       */
      sendStatusEmail: false,
      customEmail: (record) =>
        this.emailService.sendReviewInvitationEmail({
          applicationId: record.application_id,
          applicationUuid: record.id,
          firstName: record.first_name,
          email: record.email,
          reviewUrl: url,
          expiresAt: invitation.expires_at,
          subjectOverride: options.emailSubjectOverride,
          bodyOverride: options.emailBodyOverride,
        }),
    });

    return { ...result, review_url: url, expires_at: invitation.expires_at };
  }

  async withdraw(
    applicationId: string,
    options: AdminActionOptions,
  ): Promise<ActionResult> {
    const application = await this.findOrFail(applicationId);

    /*
     * §6: "Any state → withdrawn (borrower request)". Approved applications are
     * explicitly withdrawable — a borrower can decline an offer they were given.
     * Only states that have already come to rest are refused: money has moved
     * (funded), a decision was issued (declined), or the file is already closed.
     */
    if (isTerminal(application.status)) {
      throw new BadRequestException(
        `Application cannot be withdrawn from ${application.status} status.`,
      );
    }

    const previous = application.status;

    return this.runAction({
      application,
      action: 'withdraw',
      options,
      emailTemplateKey: 'application_withdrawn',
      apply: (record) => {
        record.status = ApplicationStatus.WITHDRAWN;
        record.decision = 'withdrawn';
        record.decision_at = new Date();
      },
      audit: {
        field: 'status',
        oldValue: previous,
        newValue: ApplicationStatus.WITHDRAWN,
      },
    });
  }

  /* ------------------------------------------------------------ §8.3 resend */

  /**
   * Re-send a previously logged email from the §8.3 Emails panel.
   *
   * email_log is fed by three different renderers — the §7.3 drip steps, the
   * status notices, and a few one-off sends — and only the key tells them
   * apart. Sending everything through sendStatusUpdateEmail meant a drip key
   * like `bank_verification_1` found no status config, logged a warning and
   * returned, while this method still answered "resent: true". So: dispatch on
   * the key, refuse the ones that cannot be rebuilt, and report what the send
   * actually did instead of assuming it worked.
   */
  async resendEmail(params: {
    applicationId: string;
    emailLogId: string;
    options: AdminActionOptions;
  }): Promise<{ resent: boolean; template_key: string; reason?: string }> {
    const application = await this.findOrFail(params.applicationId);
    const original = await this.emailLogService.findById(params.emailLogId);

    if (!original || original.application_id !== application.id) {
      throw new NotFoundException('Email not found for this application');
    }

    const templateKey = original.template_key;

    const details = {
      applicationId: application.application_id,
      applicationUuid: application.id,
      firstName: application.first_name,
      email: application.email,
      loanAmount: Number(application.amount_requested),
    };

    let result: SendEmailResult;

    if (hasDripTemplate(templateKey)) {
      const actionUrl = templateKey.startsWith('bank_verification')
        ? (await this.tokenService.issue(application.id, 'bank_verification'))
            .url
        : undefined;

      // Drip mail is non-transactional, so an unsubscribed borrower is skipped.
      const sent = await this.dripEmailService.sendDripEmail(templateKey, {
        ...details,
        ...(actionUrl ? { actionUrl } : {}),
      });

      result = sent
        ? { sent: true }
        : { sent: false, skippedReason: 'suppressed' };
    } else if (hasStatusTemplate(templateKey)) {
      result = await this.emailService.sendStatusUpdateEmail({
        ...details,
        status: templateKey,
      });
    } else {
      /*
       * documents_requested and friends embed a single-use link that was
       * minted for the original send. Re-rendering one would either reissue a
       * live credential or mail out a dead one, so the action that creates it
       * is the only honest way to send it again.
       */
      throw new BadRequestException(
        `"${templateKey}" cannot be resent on its own — it carries a one-time link. Re-run the action that sends it.`,
      );
    }

    await this.auditLogService.log({
      application_id: application.id,
      admin_user_id: params.options.admin.adminUserId,
      actor_type: params.options.admin.actorType,
      action: 'resend_email',
      field_changed: templateKey,
      new_value: { sent: result.sent, reason: result.skippedReason ?? null },
      note: params.options.note ?? null,
      ip_address: params.options.admin.ipAddress,
    });

    return {
      resent: result.sent,
      template_key: templateKey,
      ...(result.skippedReason ? { reason: result.skippedReason } : {}),
    };
  }

  /* ----------------------------------------------------------------- engine */

  /**
   * The shape every §8.4 button shares.
   *
   * Order is deliberate and load-bearing: the state is written and committed
   * first, then audited, then the side effects run. A failed email must never
   * roll back a recorded decision, and an action that reached the database
   * without an audit row is reported loudly rather than swallowed.
   */
  private async runAction(params: {
    application: Application;
    action: AuditAction;
    options: AdminActionOptions;
    apply: (application: Application) => void;
    audit: { field?: string; oldValue?: unknown; newValue?: unknown };
    /** Status whose template the borrower email uses; defaults to the new one. */
    emailStatus?: ApplicationStatus;
    emailTemplateKey?: string;
    emailLoanAmount?: number;
    sendStatusEmail?: boolean;
    customEmail?: (application: Application) => Promise<SendEmailResult | void>;
    skipAudit?: boolean;
    extraCancellations?: { trigger: string; sequences?: string[] };
    /** One-time borrower link to embed in the email, if this action minted one. */
    actionUrl?: string;
  }): Promise<ActionResult> {
    const { application, options } = params;

    params.apply(application);
    await application.save();

    if (!params.skipAudit) {
      await this.auditLogService.log({
        application_id: application.id,
        admin_user_id: options.admin.adminUserId,
        actor_type: options.admin.actorType,
        action: params.action,
        field_changed: params.audit.field ?? null,
        old_value: params.audit.oldValue,
        new_value: params.audit.newValue,
        note: options.note ?? null,
        ip_address: options.admin.ipAddress,
      });
    }

    const emailStatus = params.emailStatus ?? application.status;

    const outcome = await this.runSideEffects({
      application,
      status: emailStatus,
      templateKey: params.emailTemplateKey ?? emailStatus,
      options,
      loanAmount: params.emailLoanAmount,
      sendStatusEmail: params.sendStatusEmail ?? true,
      customEmail: params.customEmail,
      extraCancellations: params.extraCancellations,
      actionUrl: params.actionUrl,
      milestone: this.milestoneOf(
        params.action,
        params.audit.field,
        application,
      ),
    });

    return {
      id: application.id,
      application_id: application.application_id,
      status: application.status,
      ...outcome,
    };
  }

  /*
   * Every status transition does the same two things: tear down whichever drip
   * sequences the new status invalidates (§7.2), then notify the borrower.
   * Neither is allowed to fail the transition itself — the status is already
   * committed by the time this runs.
   */
  private async runSideEffects(params: {
    application: Application;
    status: ApplicationStatus;
    templateKey: string;
    options: AdminActionOptions;
    loanAmount?: number;
    sendStatusEmail: boolean;
    customEmail?: (application: Application) => Promise<SendEmailResult | void>;
    extraCancellations?: { trigger: string; sequences?: string[] };
    actionUrl?: string;
    /** Console headline for the milestones an admin watches for, if any. */
    milestone?: string;
  }): Promise<{ email_sent: boolean; email_withheld_reason?: string }> {
    const { application, status } = params;

    // 1. email_sequences — tear down the drips this status invalidates (§7.2).
    let cancelled = 0;

    if (params.extraCancellations) {
      cancelled += await this.cancelQuietly(
        application.id,
        params.extraCancellations.trigger,
        params.extraCancellations.sequences,
      );
    }

    const sequences = sequencesCancelledBy(status);

    if (sequences.length > 0) {
      cancelled += await this.cancelQuietly(
        application.id,
        `status:${status}`,
        sequences,
      );
    }

    /*
     * Reported here rather than in runAction, where it used to sit: up there it
     * fired before cancelSequences had run, so it announced a teardown that had
     * not happened yet and could not say how much of one it was. After the fact
     * the line carries the count, which is the part worth reading.
     */
    if (params.milestone) {
      this.logger.log(
        `${params.milestone} for application ${application.application_id} — ` +
          `cancelled ${cancelled} scheduled drip step(s) ` +
          `(trigger: ${params.extraCancellations?.trigger ?? `status:${status}`})`,
      );
    }

    // 2. email_log — either the send, or the recorded reason it was withheld.
    return this.deliverBorrowerEmail(params);
  }

  /**
   * The §8.4 email half, on its own so the buttons that are not status
   * transitions — Edit Application — can reach it without also tearing down
   * drip sequences they have no business cancelling.
   *
   * `email_sent` reports what the send actually did. It used to be hardcoded
   * true on the happy path, which meant a missing template logged a warning
   * server-side and still told the admin their borrower had been emailed.
   */
  private async deliverBorrowerEmail(params: {
    application: Application;
    status: ApplicationStatus;
    templateKey: string;
    options: AdminActionOptions;
    loanAmount?: number;
    sendStatusEmail?: boolean;
    customEmail?: (application: Application) => Promise<SendEmailResult | void>;
    actionUrl?: string;
  }): Promise<{ email_sent: boolean; email_withheld_reason?: string }> {
    const { application, status, options } = params;

    if (options.sendEmail === false) {
      const reason = await this.recordSuppressedEmail(
        application,
        params.templateKey,
        options,
      );

      return { email_sent: false, email_withheld_reason: reason };
    }

    try {
      let result: SendEmailResult = { sent: false, skippedReason: 'not_sent' };

      if (params.customEmail) {
        result = (await params.customEmail(application)) ?? {
          sent: true,
        };
      } else if (params.sendStatusEmail !== false) {
        result = await this.emailService.sendStatusUpdateEmail({
          applicationId: application.application_id,
          applicationUuid: application.id,
          firstName: application.first_name,
          email: application.email,
          loanAmount: params.loanAmount ?? Number(application.amount_requested),
          status,
          templateKey: params.templateKey,
          subjectOverride: options.emailSubjectOverride,
          bodyOverride: options.emailBodyOverride,
          actionUrl: params.actionUrl,
        });
      }

      // §8.4 "edit before sending" — the substituted copy is itself auditable.
      if (options.emailSubjectOverride || options.emailBodyOverride) {
        await this.auditLogService.log({
          application_id: application.id,
          admin_user_id: options.admin.adminUserId,
          actor_type: options.admin.actorType,
          action: 'email_edited',
          field_changed: params.templateKey,
          new_value: {
            subject: options.emailSubjectOverride ?? null,
            body_edited: Boolean(options.emailBodyOverride),
          },
          ip_address: options.admin.ipAddress,
        });
      }

      if (!result.sent) {
        this.logger.warn(
          `${params.templateKey} not delivered for ${application.application_id}` +
            ` (${result.skippedReason ?? 'unknown'})`,
        );
      }

      return {
        email_sent: result.sent,
        ...(result.sent
          ? {}
          : { email_withheld_reason: result.skippedReason ?? 'not_sent' }),
      };
    } catch (error) {
      this.logger.error(
        `Failed to send ${params.templateKey} email for ${application.application_id}`,
        error instanceof Error ? error.stack : String(error),
      );

      return { email_sent: false, email_withheld_reason: 'send_failed' };
    }
  }

  private async cancelQuietly(
    applicationUuid: string,
    trigger: string,
    sequences?: string[],
  ): Promise<number> {
    try {
      return await this.dripService.cancelSequences(
        applicationUuid,
        trigger,
        sequences as never,
      );
    } catch (error) {
      this.logger.error(
        `Failed to cancel drip sequences (${trigger}) for ${applicationUuid}`,
        error instanceof Error ? error.stack : String(error),
      );

      return 0;
    }
  }

  /**
   * The two steps an admin waits on — the call landing and Plaid coming back —
   * are the ones worth a line in the server log. Everything else is already
   * legible from audit_log, so it stays quiet.
   */
  private milestoneOf(
    action: AuditAction,
    field: string | undefined,
    application: Application,
  ): string | undefined {
    if (action === 'mark_called_in') {
      return 'Call completed';
    }

    if (
      field === 'bank_verified' &&
      application.status === ApplicationStatus.BANK_VERIFICATION_COMPLETE
    ) {
      return 'Bank verification completed';
    }

    return undefined;
  }

  /**
   * §8.4: the "do not send email" override "requires a reason (logged)".
   *
   * Logged in both places it matters — audit_log, because an admin chose to
   * withhold borrower communication, and email_log, so the gap in the
   * borrower's mail history has an explanation attached to it.
   */
  private async recordSuppressedEmail(
    application: Application,
    templateKey: string,
    options: AdminActionOptions,
  ): Promise<string> {
    const reason = options.emailOverrideReason?.trim();

    if (!reason) {
      throw new BadRequestException(
        'A reason is required when suppressing the borrower email.',
      );
    }

    await this.auditLogService.log({
      application_id: application.id,
      admin_user_id: options.admin.adminUserId,
      actor_type: options.admin.actorType,
      action: 'email_suppressed',
      field_changed: templateKey,
      note: reason,
      ip_address: options.admin.ipAddress,
    });

    try {
      const log = await this.emailLogService.recordQueuedEmail({
        application_id: application.id,
        template_key: templateKey,
        to_email: application.email,
        subject: `[not sent] ${templateKey}`,
        scheduled_for: new Date(),
      });

      await log.update({
        status: 'cancelled',
        cancelled_reason: `admin_override: ${reason}`,
      });
    } catch (error) {
      this.logger.error(
        `Failed to record suppressed ${templateKey} email for ${application.application_id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return reason;
  }

  /* ---------------------------------------------------------------- helpers */

  /**
   * Resolve either identifier a caller might hold.
   *
   * Admin routes carry the six-character reference from the URL; the borrower
   * action service holds the row it already loaded and passes its primary key.
   * This looked up `application_id` only, so every borrower-driven edge in
   * §6.1 — Plaid success, e-signature, deposit confirmation — reached this with
   * a UUID, matched nothing, and 404'd *after* the one-time token had been
   * consumed. Each of those was a link the borrower could not retry.
   */
  private async findOrFail(applicationId: string): Promise<Application> {
    const application = UUID_PATTERN.test(applicationId)
      ? await this.applicationModel.findByPk(applicationId)
      : await this.applicationModel.findOne({
          where: { application_id: applicationId.toUpperCase() },
        });

    if (!application) throw new NotFoundException('Application not found');

    return application;
  }

  private requireStatus(
    application: Application,
    expected: ApplicationStatus,
  ): void {
    if (application.status !== expected) {
      throw new BadRequestException(
        `Application must be in ${expected} status. ` +
          `Current status: ${application.status}`,
      );
    }
  }

  private borrowerBaseUrl(): string {
    return (
      process.env.BORROWER_BASE_URL ??
      process.env.FRONTEND_URL ??
      // 'https://ryerloans.com'
      // 'http://localhost:3000'
      'https://ryerloans-frontend.vercel.app'
    ).replace(/\/$/, '');
  }

  private documentRequestEmailHtml(
    application: Application,
    docTypes: DocumentType[],
    uploadUrl: string,
    expiresAt: Date,
  ): string {
    const items = docTypes
      .map(
        (type) =>
          `<li style="margin:6px 0;color:#374151;">${DOCUMENT_TYPE_LABELS[type]}</li>`,
      )
      .join('');

    return `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#0b2545;">Documents needed</h2>
        <p style="color:#374151;font-size:16px;">Hi ${application.first_name},</p>
        <p style="color:#374151;font-size:16px;">
          To continue reviewing application
          <strong>#${application.application_id}</strong> we need the following:
        </p>
        <ul style="padding-left:20px;">${items}</ul>
        <p style="margin:24px 0;">
          <a href="${uploadUrl}"
             style="background:#0b82d6;color:#ffffff;padding:12px 22px;
                    border-radius:6px;text-decoration:none;display:inline-block;">
            Upload your documents
          </a>
        </p>
        <p style="color:#6b7280;font-size:14px;">
          This secure link expires on ${expiresAt.toDateString()}.
        </p>
        <p style="color:#6b7280;font-size:13px;">
          Ryer Loans will never ask you to send money, buy a gift card, or pay a
          fee before your loan is funded.
        </p>
      </div>
    `;
  }
}
