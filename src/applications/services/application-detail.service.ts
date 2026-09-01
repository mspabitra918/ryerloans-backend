import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';

import { Application } from '../models/application.model';
import { ApplicationNote } from '../models/application-note.model';
import {
  AdminUser,
  AdminRole,
} from '../../admin-users/models/admin-user.model';
import { AuditLog } from '../../audit-log/models/audit-log.model';
import { EmailLog } from '../../email-log/models/email-log.model';
import { Document } from '../../documents/models/document.model';
import { ApplicationStatus } from '../dto/application-enums';
import { humanizeStatus } from '../application-status.machine';
import {
  ADMIN_TIMEZONE,
  ECOA_REASON_CODES,
  type AdminActionOptions,
} from '../application.types';
import { FieldCryptoService } from '../../common/crypto/field-crypto.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuthService } from '../../auth/auth.service';
import { hasStatusTemplate } from '../../email/email.service';
import { hasDripTemplate } from '../../queue/drip/drip-email.service';
import {
  maskAccount,
  maskLicense,
  maskSsn,
  formatPhone,
} from '../../common/pii/mask.util';
import {
  REVEALABLE_FIELDS,
  REVEAL_ALLOWED_ROLES,
  SUPER_ADMIN_ONLY_EDIT_FIELDS,
  type RevealableField,
} from '../../common/pii/pii.constants';
import type { AuthenticatedAdmin } from '../../auth/auth.types';

/** Fields an admin may correct through §8.4 "Edit Application". */
const EDITABLE_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'dob',
  'street_address',
  'address_line_2',
  'city',
  'state',
  'zip',
  'years_at_address',
  'housing_status',
  'monthly_housing_cost',
  'employment_status',
  'employer_name',
  'job_title',
  'employment_length_mo',
  'employer_phone',
  'pay_frequency',
  'next_pay_date',
  'net_monthly_income',
  'income_source',
  'owns_vehicle',
  'vehicle_year',
  'vehicle_make',
  'vehicle_model',
  'vehicle_paid_off',
  'bank_name',
  'account_type',
  'account_age_months',
  'current_balance_band',
  'direct_deposit',
  'amount_requested',
  'loan_purpose',
  'loan_purpose_other',
  'dl_state',
  // Encrypted; handled separately and gated to super_admin.
  'ssn',
  'dl_number',
  'routing_number',
  'account_number',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Fields whose value the borrower sees, so an edit to them warrants an email. */
const BORROWER_VISIBLE_FIELDS = new Set<string>([
  'first_name',
  'last_name',
  'email',
  'phone',
  'street_address',
  'address_line_2',
  'city',
  'state',
  'zip',
  'amount_requested',
  'loan_purpose',
  'bank_name',
  'account_type',
]);

/** One entry in the §8.3 reverse-chronological timeline. */
export interface TimelineEntry {
  at: Date;
  kind: 'status' | 'admin_action' | 'email' | 'document' | 'note' | 'milestone';
  label: string;
  detail?: string | null;
  actor?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Response shapes are declared explicitly rather than inferred.
 *
 * Partly so the contract the admin portal codes against is written down in one
 * place, and partly because inferring them from Sequelize models leaks the
 * ORM's internal `CreationOptional` brands into the emitted declarations.
 */
export interface NoteView {
  id: string;
  body: string;
  created_at: Date;
  author_id: string;
  author_email: string | null;
}

export interface DocumentView {
  id: string;
  doc_type: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  scan_status: string;
  scanned_at: Date | null;
  uploaded_by: string;
  created_at: Date;
  downloadable: boolean;
}

export interface EmailView {
  id: string;
  template_key: string;
  subject: string;
  to_email: string;
  status: string;
  scheduled_for: Date | null;
  sent_at: Date | null;
  opened_at: Date | null;
  bounced_at: Date | null;
  complaint_at: Date | null;
  cancelled_reason: string | null;
  resendable: boolean;
}

export interface ApplicationDetailView {
  header: Record<string, unknown>;
  loan_request: Record<string, unknown>;
  personal: Record<string, unknown>;
  employment: Record<string, unknown>;
  vehicle: Record<string, unknown>;
  banking: Record<string, unknown>;
  decision: Record<string, unknown>;
  provenance: Record<string, unknown>;
  timeline: TimelineEntry[];
  documents: DocumentView[];
  notes: NoteView[];
  emails: EmailView[];
}

/**
 * §8.3 application detail: the panels, the timeline, the Reveal control, and
 * the audited edit path.
 */
@Injectable()
export class ApplicationDetailService {
  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    @InjectModel(ApplicationNote)
    private readonly noteModel: typeof ApplicationNote,
    @InjectModel(AuditLog)
    private readonly auditLogModel: typeof AuditLog,
    @InjectModel(EmailLog)
    private readonly emailLogModel: typeof EmailLog,
    @InjectModel(Document)
    private readonly documentModel: typeof Document,
    @InjectModel(AdminUser)
    private readonly adminUserModel: typeof AdminUser,
    private readonly crypto: FieldCryptoService,
    private readonly auditLogService: AuditLogService,
    private readonly authService: AuthService,
  ) {}

  async findOrFail(applicationId: string): Promise<Application> {
    const application = await this.applicationModel.findOne({
      where: { application_id: applicationId.toUpperCase() },
      include: [
        {
          model: AdminUser,
          as: 'assigned_agent',
          attributes: ['id', 'email'],
          required: false,
        },
      ],
    });

    if (!application) throw new NotFoundException('Application not found');

    return application;
  }

  /**
   * The full §8.3 detail page in one round trip.
   *
   * PII is masked here without exception. Nothing on this response can be
   * un-masked by a query parameter — the only way to a full SSN or account
   * number is POST .../reveal, which re-checks the password and writes an
   * audit row.
   */
  async detail(applicationId: string): Promise<ApplicationDetailView> {
    const application = await this.findOrFail(applicationId);

    const [notes, auditRows, emails, documents] = await Promise.all([
      this.listNotes(application.id),
      this.auditLogModel.findAll({
        where: { application_id: application.id },
        order: [['created_at', 'DESC']],
        limit: 500,
      }),
      this.emailLogModel.findAll({
        where: { application_id: application.id },
        order: [['created_at', 'DESC']],
        limit: 200,
      }),
      this.documentModel.findAll({
        where: {
          application_id: application.id,
          deleted_at: { [Op.is]: null },
        },
        order: [['created_at', 'DESC']],
      }),
    ]);

    const adminNames = await this.resolveAdminNames([
      ...auditRows.map((row) => row.admin_user_id),
      application.called_in_by_admin ?? null,
    ]);

    const agent = (application as unknown as { assigned_agent?: AdminUser })
      .assigned_agent;

    return {
      header: {
        id: application.id,
        application_id: application.application_id,
        full_name: `${application.first_name} ${application.last_name}`.trim(),
        status: application.status,
        status_label: humanizeStatus(application.status),
        amount_requested: Number(application.amount_requested),
        submitted_at: application.created_at ?? null,
        assigned_agent: agent ? { id: agent.id, email: agent.email } : null,
        possible_duplicate: Boolean(application.possible_duplicate),
      },

      loan_request: this.loanRequestPanel(application),
      personal: this.personalPanel(application),
      employment: this.employmentPanel(application),
      vehicle: this.vehiclePanel(application),
      banking: this.bankingPanel(application),
      decision: this.decisionPanel(application),
      provenance: this.provenancePanel(application),

      timeline: this.buildTimeline({
        application,
        auditRows,
        emails,
        documents,
        notes,
        adminNames,
      }),

      documents: documents.map((document): DocumentView => ({
        id: document.id,
        doc_type: document.doc_type,
        original_filename: document.original_filename,
        mime_type: document.mime_type,
        size_bytes: Number(document.size_bytes),
        scan_status: document.scan_status,
        scanned_at: document.scanned_at,
        uploaded_by: document.uploaded_by,
        created_at: document.created_at,
        // §8.3 presigned download links. Only a clean file gets one — an
        // unscanned or infected upload must never be one click from a laptop.
        downloadable: document.scan_status === 'clean',
      })),

      notes,

      emails: emails.map((email): EmailView => ({
        id: email.id,
        template_key: email.template_key,
        subject: email.subject,
        to_email: email.to_email,
        status: email.status,
        scheduled_for: email.scheduled_for,
        sent_at: email.sent_at,
        opened_at: email.opened_at,
        bounced_at: email.bounced_at,
        complaint_at: email.complaint_at,
        cancelled_reason: email.cancelled_reason,
        // Only offer a resend the §8.3 resend endpoint can actually honour:
        // a one-off send whose body carried a single-use link cannot be rebuilt.
        resendable:
          email.status !== 'queued' &&
          (hasDripTemplate(email.template_key) ||
            hasStatusTemplate(email.template_key)),
      })),
    };
  }

  /* ---------------------------------------------------------------- panels */

  /** §8.3: "calculated payment at 10% APR". */
  private loanRequestPanel(application: Application) {
    const amount = Number(application.amount_requested);
    const termMonths = application.approved_term_months ?? 24;
    const apr =
      application.approved_apr !== undefined &&
      application.approved_apr !== null
        ? Number(application.approved_apr)
        : 10;

    return {
      amount_requested: amount,
      loan_purpose: application.loan_purpose,
      loan_purpose_other: application.loan_purpose_other ?? null,
      illustrative_apr: apr,
      illustrative_term_months: termMonths,
      estimated_monthly_payment: ApplicationDetailService.monthlyPayment(
        amount,
        apr,
        termMonths,
      ),
    };
  }

  private personalPanel(application: Application) {
    return {
      first_name: application.first_name,
      last_name: application.last_name,
      email: application.email,
      phone: formatPhone(application.phone),
      dob: application.dob,
      // Masked by default; the Reveal control is the only way past this.
      ssn_masked: maskSsn(application.ssn_last4),
      dl_number_masked: application.dl_number_encrypted
        ? maskLicense('••••••')
        : null,
      dl_state: application.dl_state ?? null,
      street_address: application.street_address,
      address_line_2: application.address_line_2 ?? null,
      city: application.city,
      state: application.state,
      zip: application.zip,
      years_at_address: application.years_at_address ?? null,
      housing_status: application.housing_status ?? null,
      monthly_housing_cost: application.monthly_housing_cost ?? null,
    };
  }

  /** §8.3: "Employment & Income — with DTI auto-calculated". */
  private employmentPanel(application: Application) {
    const netMonthlyIncome = Number(application.net_monthly_income) || 0;
    const housingCost = Number(application.monthly_housing_cost) || 0;

    const estimatedPayment = ApplicationDetailService.monthlyPayment(
      Number(application.amount_requested),
      application.approved_apr !== undefined &&
        application.approved_apr !== null
        ? Number(application.approved_apr)
        : 10,
      application.approved_term_months ?? 24,
    );

    /*
     * DTI here is housing plus the proposed loan payment over net monthly
     * income. The application does not collect other debt obligations, so this
     * is explicitly a partial ratio — labelling it plain "DTI" would overstate
     * what the number covers to whoever is underwriting off it.
     */
    const obligations = housingCost + (estimatedPayment ?? 0);

    return {
      employment_status: application.employment_status,
      employer_name: application.employer_name ?? null,
      job_title: application.job_title ?? null,
      employment_length_mo: application.employment_length_mo ?? null,
      employer_phone: formatPhone(application.employer_phone),
      pay_frequency: application.pay_frequency,
      next_pay_date: application.next_pay_date ?? null,
      net_monthly_income: netMonthlyIncome,
      income_source: application.income_source ?? null,
      monthly_housing_cost: housingCost || null,
      estimated_loan_payment: estimatedPayment,
      dti: {
        basis: 'housing_plus_proposed_loan_over_net_income',
        obligations,
        percent:
          netMonthlyIncome > 0
            ? Number(((obligations / netMonthlyIncome) * 100).toFixed(2))
            : null,
      },
    };
  }

  private vehiclePanel(application: Application) {
    return {
      owns_vehicle: Boolean(application.owns_vehicle),
      vehicle_year: application.vehicle_year ?? null,
      vehicle_make: application.vehicle_make ?? null,
      vehicle_model: application.vehicle_model ?? null,
      vehicle_paid_off: application.vehicle_paid_off ?? null,
    };
  }

  private bankingPanel(application: Application) {
    return {
      bank_name: application.bank_name,
      account_type: application.account_type,
      account_masked: maskAccount(application.account_last4),
      routing_masked: '••••••••',
      account_age_months: application.account_age_months,
      current_balance_band: application.current_balance_band,
      direct_deposit: application.direct_deposit ?? null,
      bank_verified: Boolean(application.bank_verified),
      bank_verified_at: application.bank_verified_at ?? null,
      plaid_item_id: application.plaid_item_id ?? null,
      verification_status: application.bank_verified
        ? 'verified'
        : application.plaid_item_id
          ? 'link_created'
          : 'not_started',
    };
  }

  private decisionPanel(application: Application) {
    return {
      decision: application.decision ?? null,
      decision_at: application.decision_at ?? null,
      approved_term_months: application.approved_term_months ?? null,
      approved_apr:
        application.approved_apr !== undefined &&
        application.approved_apr !== null
          ? Number(application.approved_apr)
          : null,
      funded_at: application.funded_at ?? null,
      funded_amount:
        application.funded_amount !== undefined &&
        application.funded_amount !== null
          ? Number(application.funded_amount)
          : null,
      decline_reason_codes: (application.decline_reason_codes ?? []).map(
        (code) => ({
          code,
          label: ECOA_REASON_CODES[code] ?? code,
        }),
      ),
      adverse_action_reference: application.adverse_action_reference ?? null,
      reapply_eligible_date: application.reapply_eligible_date ?? null,
    };
  }

  /**
   * §8.3 Provenance, including the mismatch warning.
   *
   * IP geolocation is coarse and a mismatch is not fraud on its own — VPNs,
   * mobile carriers and corporate egress all produce them. It is surfaced as a
   * flag for a human, never as an automatic decision.
   */
  private provenancePanel(application: Application) {
    const statedState = application.state?.toUpperCase() ?? null;
    const ipRegion = application.ip_region ?? null;
    const ipCountry = application.ip_country ?? null;

    const regionMismatch = Boolean(
      statedState && ipRegion && ipRegion.toUpperCase() !== statedState,
    );

    const countryMismatch = Boolean(
      ipCountry && ipCountry.toUpperCase() !== 'US',
    );

    const formDurationSeconds =
      application.form_started_at && application.form_completed_at
        ? Math.max(
            Math.round(
              (application.form_completed_at.getTime() -
                application.form_started_at.getTime()) /
                1000,
            ),
            0,
          )
        : null;

    return {
      ip_address: application.ip_address,
      ip_country: ipCountry,
      ip_region: ipRegion,
      user_agent: application.user_agent ?? null,
      device_type: ApplicationDetailService.deviceType(application.user_agent),
      referrer: application.referrer ?? null,
      landing_page: application.landing_page ?? null,
      utm: {
        source: application.utm_source ?? null,
        medium: application.utm_medium ?? null,
        campaign: application.utm_campaign ?? null,
      },
      form_started_at: application.form_started_at ?? null,
      form_completed_at: application.form_completed_at ?? null,
      form_duration_seconds: formDurationSeconds,
      // A form completed implausibly fast is the signal worth flagging here.
      form_duration_suspicious:
        formDurationSeconds !== null && formDurationSeconds < 60,
      warnings: [
        regionMismatch
          ? {
              code: 'ip_region_mismatch',
              message:
                `Submission IP geolocates to ${ipRegion} but the stated home ` +
                `state is ${statedState}.`,
            }
          : null,
        countryMismatch
          ? {
              code: 'ip_country_mismatch',
              message: `Submission IP geolocates outside the US (${ipCountry}).`,
            }
          : null,
      ].filter((warning): warning is { code: string; message: string } =>
        Boolean(warning),
      ),
    };
  }

  /* -------------------------------------------------------------- timeline */

  /**
   * §8.3: "every status change, email sent/opened/bounced, admin action,
   * document upload, in one reverse-chronological feed".
   *
   * Merged in memory rather than with a UNION query: the four sources have
   * nothing in common but a timestamp, and each is already bounded to a few
   * hundred rows for a single application.
   */
  private buildTimeline(params: {
    application: Application;
    auditRows: AuditLog[];
    emails: EmailLog[];
    documents: Document[];
    notes: NoteView[];
    adminNames: Map<string, string>;
  }): TimelineEntry[] {
    const { application, auditRows, emails, documents, notes, adminNames } =
      params;
    const entries: TimelineEntry[] = [];

    const milestones: Array<[Date | null | undefined, string]> = [
      [application.created_at, 'Application submitted'],
      [application.called_in_at, 'Borrower called in'],
      [application.bank_verified_at, 'Bank account verified'],
      [application.agreement_sent_at, 'Loan agreement sent'],
      [application.agreement_signed_at, 'Loan agreement signed'],
      [application.micro_deposit_sent_at, 'Verification deposit sent'],
      [
        application.micro_deposit_confirmed_at,
        'Verification deposit confirmed',
      ],
      [
        application.decision_at,
        `Decision recorded: ${application.decision ?? 'n/a'}`,
      ],
      [application.funded_at, 'Loan funded'],
      [application.documents_requested_at, 'Documents requested'],
    ];

    for (const [at, label] of milestones) {
      if (at) entries.push({ at, kind: 'milestone', label });
    }

    for (const row of auditRows) {
      entries.push({
        at: row.created_at,
        kind: row.action === 'status_change' ? 'status' : 'admin_action',
        label: humanizeStatus(row.action),
        detail: row.field_changed
          ? `Changed ${row.field_changed}${row.note ? ` — ${row.note}` : ''}`
          : (row.note ?? null),
        /*
         * A null admin_user_id is a §6.1 borrower-driven action, not missing
         * data. The feed names the borrower rather than falling back to a
         * blank actor, which is what an E-SIGN dispute needs it to say.
         */
        actor: row.admin_user_id
          ? (adminNames.get(row.admin_user_id) ?? row.admin_user_id)
          : row.actor_type === 'borrower'
            ? 'Borrower'
            : 'System',
        meta: { ip_address: row.ip_address },
      });
    }

    for (const email of emails) {
      // One log row can represent up to four observable events; each is its own
      // point on the feed, which is the whole reason the panel exists.
      const events: Array<[Date | null | undefined, string]> = [
        [email.sent_at, 'Email sent'],
        [email.opened_at, 'Email opened'],
        [email.bounced_at, 'Email bounced'],
        [email.complaint_at, 'Spam complaint'],
      ];

      for (const [at, label] of events) {
        if (at) {
          entries.push({
            at,
            kind: 'email',
            label,
            detail: email.subject,
            meta: { template_key: email.template_key, email_log_id: email.id },
          });
        }
      }

      if (email.status === 'cancelled' && email.created_at) {
        entries.push({
          at: email.created_at,
          kind: 'email',
          label: 'Email withheld',
          detail: email.cancelled_reason ?? email.subject,
          meta: { template_key: email.template_key },
        });
      }
    }

    for (const document of documents) {
      entries.push({
        at: document.created_at,
        kind: 'document',
        label: `Document uploaded: ${document.doc_type}`,
        detail: document.original_filename,
        actor: document.uploaded_by,
        meta: { scan_status: document.scan_status },
      });
    }

    for (const note of notes) {
      entries.push({
        at: note.created_at,
        kind: 'note',
        label: 'Internal note',
        detail: note.body,
        actor: note.author_email,
      });
    }

    return entries.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  /* ------------------------------------------------------------------ notes */

  async listNotes(applicationUuid: string): Promise<NoteView[]> {
    const notes = await this.noteModel.findAll({
      where: { application_id: applicationUuid },
      include: [
        { model: AdminUser, attributes: ['id', 'email'], required: false },
      ],
      order: [['created_at', 'DESC']],
      limit: 200,
    });

    return notes.map((note) => ({
      id: note.id,
      body: note.body,
      created_at: note.created_at,
      author_id: note.admin_user_id,
      author_email: note.author?.email ?? null,
    }));
  }

  async addNote(params: {
    applicationId: string;
    admin: AuthenticatedAdmin;
    body: string;
  }): Promise<NoteView> {
    const application = await this.findOrFail(params.applicationId);

    const note = await this.noteModel.create({
      application_id: application.id,
      admin_user_id: params.admin.id,
      body: params.body.trim(),
    });

    return {
      id: note.id,
      body: note.body,
      created_at: note.created_at,
      author_id: params.admin.id,
      author_email: params.admin.email,
    };
  }

  /* ----------------------------------------------------------------- reveal */

  /**
   * §8.3: "SSN and DL masked with a 'Reveal' control that requires password
   * re-entry and writes to audit_log".
   *
   * The audit row is written *before* the value is returned. If the write fails
   * the reveal fails — an unlogged reveal is exactly the event this control
   * exists to make impossible.
   */
  async reveal(params: {
    applicationId: string;
    admin: AuthenticatedAdmin;
    password: string;
    field: string;
    reason?: string;
  }): Promise<{ field: RevealableField; value: string }> {
    if (!REVEAL_ALLOWED_ROLES.includes(params.admin.role)) {
      throw new ForbiddenException(
        'Your role may not reveal SSN or account numbers',
      );
    }

    if (!REVEALABLE_FIELDS.includes(params.field as RevealableField)) {
      throw new BadRequestException(
        `field must be one of: ${REVEALABLE_FIELDS.join(', ')}`,
      );
    }

    const field = params.field as RevealableField;

    await this.authService.assertPassword(params.admin.id, params.password);

    const application = await this.findOrFail(params.applicationId);
    const value = this.decryptField(application, field);

    if (value === null) {
      throw new NotFoundException(`No ${field} is stored for this application`);
    }

    const logged = await this.auditLogService.log({
      application_id: application.id,
      admin_user_id: params.admin.id,
      action: 'reveal_pii',
      field_changed: field,
      note: params.reason ?? null,
      ip_address: params.admin.ipAddress,
    });

    if (!logged) {
      throw new BadRequestException(
        'Could not record the reveal in the audit log; the value was not disclosed.',
      );
    }

    return { field, value };
  }

  private decryptField(
    application: Application,
    field: RevealableField,
  ): string | null {
    switch (field) {
      case 'ssn':
        return this.crypto.tryDecrypt(application.ssn_encrypted);
      case 'dl_number':
        return this.crypto.tryDecrypt(application.dl_number_encrypted);
      case 'account_number':
        return this.crypto.tryDecrypt(application.account_encrypted);
      case 'routing_number':
        return this.crypto.tryDecrypt(application.routing_encrypted);
    }
  }

  /* ------------------------------------------------------------------- edit */

  /**
   * §8.4 Edit Application — "admins may edit any field. Every edit writes to
   * audit_log", with SSN and bank account additionally requiring super_admin
   * and a mandatory reason note.
   *
   * Returns the field-level diff so the caller can decide whether a
   * borrower-visible field changed and an `application_updated` email is owed.
   */
  async edit(params: {
    applicationId: string;
    admin: AuthenticatedAdmin;
    changes: Record<string, unknown>;
    note?: string;
    password?: string;
  }): Promise<{
    application: Application;
    changed: Array<{ field: string; oldValue: unknown; newValue: unknown }>;
    borrowerVisibleChange: boolean;
  }> {
    const application = await this.findOrFail(params.applicationId);

    const fields = Object.keys(params.changes);

    const unknownFields = fields.filter(
      (field) => !(EDITABLE_FIELDS as readonly string[]).includes(field),
    );

    if (unknownFields.length > 0) {
      throw new BadRequestException(
        `Not editable: ${unknownFields.join(', ')}`,
      );
    }

    const sensitive = fields.filter((field) =>
      (SUPER_ADMIN_ONLY_EDIT_FIELDS as readonly string[]).includes(field),
    );

    if (sensitive.length > 0) {
      if (params.admin.role !== AdminRole.SUPER_ADMIN) {
        throw new ForbiddenException(
          `Editing ${sensitive.join(', ')} requires the super_admin role`,
        );
      }

      if (!params.note?.trim()) {
        throw new BadRequestException(
          `A reason note is mandatory when editing ${sensitive.join(', ')}`,
        );
      }

      // These are the two fields a regulator opens first; re-assert the
      // password so a walked-away session cannot rewrite them.
      if (!params.password) {
        throw new BadRequestException(
          'Password re-entry is required to edit SSN or bank account details',
        );
      }

      await this.authService.assertPassword(params.admin.id, params.password);
    }

    const changed: Array<{
      field: string;
      oldValue: unknown;
      newValue: unknown;
    }> = [];
    const updates: Record<string, unknown> = {};

    for (const [field, rawValue] of Object.entries(params.changes)) {
      const encryptedColumn = ApplicationDetailService.ENCRYPTED_COLUMNS[field];

      if (encryptedColumn) {
        const next = String(rawValue ?? '');
        const current = this.crypto.tryDecrypt(
          application[encryptedColumn] as Buffer | null,
        );

        if (current === next) continue;

        updates[encryptedColumn] = this.crypto.encrypt(next);

        // Keep the plaintext derivatives in step, or search and masking would
        // silently keep describing the old value.
        if (field === 'ssn') {
          updates.ssn_last4 = next.slice(-4);
          updates.ssn_hash = this.crypto.hash(next);
        }

        if (field === 'account_number') {
          updates.account_last4 = next.slice(-4);
        }

        // The old and new values are hashed by the audit service, so what goes
        // into the log is proof of change, never a second copy of the secret.
        changed.push({ field, oldValue: current, newValue: next });
        continue;
      }

      const current = (application as unknown as Record<string, unknown>)[
        field
      ];

      if (ApplicationDetailService.sameValue(current, rawValue)) continue;

      updates[field] = rawValue;

      // Derived columns that exist only to make a field searchable.
      if (field === 'email') {
        updates.email_normalized = String(rawValue ?? '')
          .trim()
          .toLowerCase();
      }

      if (field === 'phone') {
        updates.phone_normalized = String(rawValue ?? '')
          .replace(/\D/g, '')
          .slice(-10);
      }

      changed.push({ field, oldValue: current, newValue: rawValue });
    }

    if (changed.length === 0) {
      throw new BadRequestException('No field values were changed');
    }

    await application.update(updates);

    await this.auditLogService.logFieldChanges({
      application_id: application.id,
      admin: {
        adminUserId: params.admin.id,
        ipAddress: params.admin.ipAddress,
      },
      changes: changed,
      note: params.note ?? null,
    });

    return {
      application,
      changed,
      borrowerVisibleChange: changed.some((change) =>
        BORROWER_VISIBLE_FIELDS.has(change.field),
      ),
    };
  }

  /** §8.3 header: assign or clear the owning agent. */
  async assignAgent(params: {
    applicationId: string;
    admin: AuthenticatedAdmin;
    adminUserId: string | null;
    options?: AdminActionOptions;
  }): Promise<{ assigned_agent_id: string | null }> {
    const application = await this.findOrFail(params.applicationId);

    if (params.adminUserId) {
      const agent = await this.adminUserModel.findByPk(params.adminUserId);

      if (!agent || !agent.is_active) {
        throw new BadRequestException('Assignee is not an active admin user');
      }
    }

    const previous = application.assigned_agent_id ?? null;

    if (previous === params.adminUserId) {
      return { assigned_agent_id: previous };
    }

    await application.update({
      assigned_agent_id: params.adminUserId,
      assigned_at: params.adminUserId ? new Date() : null,
    });

    await this.auditLogService.log({
      application_id: application.id,
      admin_user_id: params.admin.id,
      action: 'assign_agent',
      field_changed: 'assigned_agent_id',
      old_value: previous,
      new_value: params.adminUserId,
      note: params.options?.note ?? null,
      ip_address: params.admin.ipAddress,
    });

    return { assigned_agent_id: params.adminUserId };
  }

  /* ----------------------------------------------------------------- helpers */

  private static readonly ENCRYPTED_COLUMNS: Record<
    string,
    | 'ssn_encrypted'
    | 'dl_number_encrypted'
    | 'account_encrypted'
    | 'routing_encrypted'
  > = {
    ssn: 'ssn_encrypted',
    dl_number: 'dl_number_encrypted',
    account_number: 'account_encrypted',
    routing_number: 'routing_encrypted',
  };

  private async resolveAdminNames(
    ids: Array<string | null>,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];

    if (unique.length === 0) return new Map();

    const users = await this.adminUserModel.findAll({
      where: { id: { [Op.in]: unique } },
      attributes: ['id', 'email'],
    });

    return new Map(users.map((user) => [user.id, user.email]));
  }

  /**
   * Loose comparison so an unchanged value submitted as a string ("2500" for an
   * integer column) does not register as an edit and pollute the audit log.
   */
  private static sameValue(current: unknown, next: unknown): boolean {
    if (current === next) return true;
    if (current === null || current === undefined)
      return next === null || next === undefined;
    if (next === null || next === undefined) return false;

    if (current instanceof Date) {
      return current.toISOString() === new Date(next as string).toISOString();
    }

    return String(current) === String(next);
  }

  /**
   * Standard amortised payment. Returns the principal spread evenly when the
   * APR is zero, which the closed form cannot express (it divides by zero).
   */
  static monthlyPayment(
    principal: number,
    aprPercent: number,
    termMonths: number,
  ): number | null {
    if (!principal || !termMonths || termMonths <= 0) return null;

    const monthlyRate = aprPercent / 100 / 12;

    if (monthlyRate === 0) {
      return Number((principal / termMonths).toFixed(2));
    }

    const factor = Math.pow(1 + monthlyRate, termMonths);

    return Number(
      ((principal * monthlyRate * factor) / (factor - 1)).toFixed(2),
    );
  }

  /** Coarse device class for the §8.3 Provenance panel. */
  static deviceType(
    userAgent?: string | null,
  ): 'mobile' | 'tablet' | 'desktop' | null {
    if (!userAgent) return null;

    const value = userAgent.toLowerCase();

    if (/ipad|tablet|playbook|silk/.test(value)) return 'tablet';
    if (/mobi|android|iphone|ipod|windows phone/.test(value)) return 'mobile';

    return 'desktop';
  }

  static readonly TIMEZONE = ADMIN_TIMEZONE;
  static readonly STATUSES = ApplicationStatus;
}
