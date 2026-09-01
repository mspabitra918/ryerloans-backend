import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';

import { SuppressionService } from './suppression.service';
import { EmailLogService } from '../email-log/email-log.service';
import { buildUnsubscribeUrl } from './unsubscribe.util';
import {
  BRAND_NAME,
  PHONE_LINK,
  SUPPORT_PHONE_DISPLAY,
  verifyBankUrl,
} from './brand.constants';

/* =========================================================
   TYPES
========================================================= */

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  campaignId?: string;

  /**
   * Transactional mail (status changes, agreements, adverse action) still
   * reaches borrowers who unsubscribed from marketing, and carries no
   * List-Unsubscribe header. Drip mail is not transactional. Defaults to true
   * so a caller that forgets to classify never silently drops a legal notice.
   */
  transactional?: boolean;

  /** §7.3 template key, recorded on email_log for auditability. */
  templateKey?: string;

  /** Business application_id, recorded on email_log. */
  applicationId?: string;
}

export interface SendEmailResult {
  sent: boolean;
  /** Set when the send was skipped rather than delivered. */
  skippedReason?: string;
  providerMessageId?: string;
}

interface ApplicationDetails {
  applicationId: string;
  /** applications.id, for the email_log FK. */
  applicationUuid?: string;
  firstName: string;
  lastName: string;
  email: string;
  loanAmount: number;
  loanPurpose: string;
}

export interface StatusUpdateDetails {
  applicationId: string;
  /** applications.id, for the email_log FK. */
  applicationUuid?: string;
  firstName: string;
  email: string;
  loanAmount: number;
  status: string;

  /**
   * §8.4 template key, for the buttons whose email is not named after the
   * status the file lands in — "Mark as Called In" moves the file to
   * bank_verification_pending but sends `call_confirmed`, and "Send Bank
   * Verification" sends
   * `bank_verification_requested` without moving the status at all.
   *
   * The key selects the template AND is what email_log records, so the log can
   * never name a template that was not the one rendered.
   */
  templateKey?: string;

  /**
   * §8.4 "edit before sending": the confirmation modal lets an admin rewrite
   * the copy for one send. Both are substituted verbatim — the admin is
   * accountable for what they typed, and the substitution is audited by the
   * caller.
   */
  subjectOverride?: string;
  bodyOverride?: string;

  /**
   * The one-time link for the §6.1 borrower edges — verify bank, sign
   * agreement, confirm deposit.
   *
   * Passed in rather than derived from applicationId, because the token is
   * minted per send and is the only thing authenticating the borrower on the
   * endpoint the link lands on. A template that falls back to an
   * applicationId-only URL sends the borrower somewhere they cannot act.
   */
  actionUrl?: string;
}

/**
 * The post-funding review request.
 *
 * Separate from StatusUpdateDetails because it is not a status notice: the file
 * is already funded and nothing about it is changing. It carries a link and an
 * expiry, and it is the one borrower email in this service that is marketing
 * rather than transactional.
 */
export interface ReviewInvitationDetails {
  applicationId: string;
  /** applications.id, for the email_log FK. */
  applicationUuid?: string;
  firstName: string;
  email: string;
  /** The tokenised review form URL, minted per send. */
  reviewUrl: string;
  expiresAt: Date;

  /** §8.4 "edit before sending", same contract as the status notices. */
  subjectOverride?: string;
  bodyOverride?: string;
}

interface StatusEmailConfig {
  title: string;
  subject?: string;
  message?: string;
  color: string;
  icon: string;

  customBody?: (
    details: StatusUpdateDetails,
    formattedAmount: string,
  ) => string;
}

/* =========================================================
   STATUS EMAIL CONFIG
========================================================= */

/**
 * Templates whose body is a one-time borrower link.
 *
 * They live in statusConfig because the action that sends them mints a token
 * first, but they cannot be rebuilt from `status` alone: re-rendering one
 * without a fresh token produces an email whose only purpose — the button — is
 * missing. §8.3's resend control has to refuse them and say so, and the action
 * that mints the link is the way to send them again.
 */
const LINK_BEARING_TEMPLATES = new Set([
  'bank_verification_requested',
  'agreement_sent',
  'verification_deposit_sent',
]);

/**
 * Whether a status notice can be rebuilt from `status` alone — which is what
 * makes it safe to resend. Drip steps and the one-off sends that embed a
 * single-use link are deliberately not in here.
 */
export function hasStatusTemplate(templateKey: string): boolean {
  return (
    templateKey in statusConfig && !LINK_BEARING_TEMPLATES.has(templateKey)
  );
}

/**
 * The call-to-action button for a template whose whole purpose is the link.
 *
 * Renders nothing when there is no `actionUrl`. That matters: these links are
 * single-use tokens minted per send, so a resend that cannot mint one must show
 * the borrower no button at all rather than a dead or, worse, a stale-but-live
 * one. LINK_BEARING_TEMPLATES keeps these keys out of the §8.3 resend path for
 * the same reason, so in practice the empty case only guards a template used
 * without its minting action.
 */
function actionButton(url: string | undefined, label: string): string {
  if (!url) return '';

  return `
      <p style="margin:24px 0;">
        <a
          href="${url}"
          style="
            background:#1a56db;
            color:#ffffff;
            padding:12px 22px;
            border-radius:6px;
            text-decoration:none;
            display:inline-block;
            font-size:16px;
          "
        >
          ${label}
        </a>
      </p>
  `;
}

const statusConfig: Record<string, StatusEmailConfig> = {
  received: {
    title: 'Application Received',
    subject: 'Application Received - Ryer Loans',
    message:
      'We have successfully received your loan application. Our team will review your information and notify you of the next step.',
    color: '#2563eb',
    icon: '&#128221;',
  },

  pending_call: {
    title: 'Please Contact Ryer Loans',
    subject: 'Action Required: Please Contact Ryer Loans',
    message: '',
    customBody: (details) => `
      <p style="color:#374151;font-size:16px;">
        Hi ${details.firstName},
      </p>

      <p style="color:#374151;font-size:16px;">
        We need to speak with you regarding your loan application
        before we can continue processing your application.
      </p>

      <div style="
        background:#fef3c7;
        border:1px solid #f59e0b;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#92400e;font-size:15px;margin:0;">
          <strong>Action Required:</strong>
          Please contact our team at
          <a
            href="tel:+17472005220"
            style="color:#1a56db;text-decoration:none;"
          >
            (747) 200-5220
          </a>
          so we can continue processing your application.
        </p>
      </div>

      <p style="color:#374151;font-size:16px;">
        Please have your Application ID available when contacting us.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Best regards,<br/>
        The Ryer Loans Team
      </p>
    `,
    color: '#f59e0b',
    icon: '&#128222;',
  },

  in_review: {
    title: 'Application Under Review',
    subject: 'Your Ryer Loans Application Is Under Review',
    message:
      'Your application is currently being reviewed by our team. No action is required from you at this time. We will notify you when there is an update.',
    color: '#2563eb',
    icon: '&#128269;',
  },

  /**
   * §8.4 "Mark as Called In" → `call_confirmed`.
   *
   * Named after the event, not the status: the button moves the file to
   * bank_verification_pending, but what the borrower needs to read is that the
   * call landed and what happens next.
   */
  call_confirmed: {
    title: 'Thanks for Calling',
    subject: 'We Have Spoken - Your Ryer Loans Application Is Moving Forward',
    message: '',
    customBody: (details) => `
      <p style="color:#374151;font-size:16px;">
        Hi ${details.firstName},
      </p>

      <p style="color:#374151;font-size:16px;">
        Thank you for speaking with our team. We have recorded your call and
        your application is now with our review team.
      </p>

      <div style="
        background:#ecfdf5;
        border:1px solid #6ee7b7;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#065f46;font-size:15px;margin:0;">
          <strong>What happens next:</strong>
          We will review your file and email you the bank verification step.
          You do not need to call us again.
        </p>
      </div>

      <p style="color:#374151;font-size:16px;">
        Your Application ID is
        <strong>${details.applicationId}</strong>.
      </p>

      <p style="color:#374151;font-size:16px;">
        You will not receive any further call reminders from us.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Best regards,<br/>
        The Ryer Loans Team
      </p>
    `,
    color: '#16a34a',
    icon: '&#128222;',
  },

  /**
   * §8.4 "Send Bank Verification" → `bank_verification_requested`.
   *
   * Distinct from the six-step `bank_verification_*` drip: this one is the
   * transactional send an admin triggers on demand, and it goes out even to a
   * borrower who unsubscribed from the reminders.
   */
  bank_verification_requested: {
    title: 'Bank Verification Required',
    subject: 'Action Required: Verify Your Bank Account',
    message: '',
    customBody: (details) => `
      <p style="color:#374151;font-size:16px;">
        Hi ${details.firstName},
      </p>

      <p style="color:#374151;font-size:16px;">
        We need you to complete the bank verification step before we can
        continue processing your application. The link below is fresh and
        takes under a minute.
      </p>

      <div style="
        background:#eff6ff;
        border:1px solid #93c5fd;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#1e40af;font-size:15px;margin:0;">
          <strong>Next Step:</strong>
          Securely connect and verify the bank account you want your funds
          sent to.
        </p>
      </div>

      <p style="margin:24px 0;">
        <a
          href="${details.actionUrl ?? verifyBankUrl()}"
          style="
            background:#1a56db;
            color:#ffffff;
            padding:12px 22px;
            border-radius:6px;
            text-decoration:none;
            display:inline-block;
            font-size:16px;
          "
        >
          Verify My Bank Account
        </a>
      </p>

      <p style="color:#374151;font-size:16px;">
        Your Application ID is
        <strong>${details.applicationId}</strong>.
      </p>

      <p style="color:#6b7280;font-size:14px;">
        This link replaces any verification link we sent you earlier. If you
        have already completed bank verification, you can disregard this
        message.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Best regards,<br/>
        The Ryer Loans Underwriting Team
      </p>
    `,
    color: '#f59e0b',
    icon: '&#128179;',
  },

  /**
   * §8.4 "Edit Application" → `application_updated`, sent only when a field the
   * borrower can actually see was changed.
   *
   * It deliberately does NOT quote the old and new values. The edit may touch
   * an SSN or a bank account number, and mail is not the place to echo either
   * back; the field-level diff lives in audit_log, which is where a dispute is
   * settled from.
   */
  application_updated: {
    title: 'Your Application Details Were Updated',
    subject: 'Your Ryer Loans Application Details Have Been Updated',
    message: '',
    customBody: (details) => `
      <p style="color:#374151;font-size:16px;">
        Hi ${details.firstName},
      </p>

      <p style="color:#374151;font-size:16px;">
        A member of our team has updated the details on your loan application
        at your request.
      </p>

      <div style="
        background:#f3f4f6;
        border:1px solid #d1d5db;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#374151;font-size:15px;margin:0;">
          <strong>Application ID:</strong>
          ${details.applicationId}
        </p>
      </div>

      <p style="color:#374151;font-size:16px;">
        Please review your information and contact us right away if anything
        does not look right. We have not changed the status of your
        application.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Best regards,<br/>
        The Ryer Loans Team
      </p>
    `,
    color: '#2563eb',
    icon: '&#9998;',
  },

  bank_verification_complete: {
    title: 'Bank Verification Complete',
    subject: 'Bank Verification Complete - Ryer Loans',
    message:
      'Your bank account verification has been successfully completed. Your application can now move forward to the next stage of processing.',
    color: '#16a34a',
    icon: '&#9989;',
  },

  agreement_sent: {
    title: 'Loan Agreement Ready',
    subject: 'Action Required: Review Your Ryer Loans Agreement',
    message: '',
    customBody: (details) => `
      <p style="color:#374151;font-size:16px;">
        Hi ${details.firstName},
      </p>

      <p style="color:#374151;font-size:16px;">
        Your loan agreement is now available for review.
      </p>

      <div style="
        background:#eff6ff;
        border:1px solid #93c5fd;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#1e40af;font-size:15px;margin:0;">
          <strong>Action Required:</strong>
          Please carefully review your loan agreement and complete
          the electronic signing process if you wish to proceed.
        </p>
      </div>

      ${actionButton(details.actionUrl, 'Review &amp; Sign My Agreement')}

      <p style="color:#374151;font-size:16px;">
        Your Application ID is
        <strong>${details.applicationId}</strong>.
      </p>

      <p style="color:#374151;font-size:16px;">
        Please review all loan terms, fees, payment obligations,
        and disclosures before signing.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Best regards,<br/>
        The Ryer Loans Team
      </p>
    `,
    color: '#2563eb',
    icon: '&#128196;',
  },

  agreement_signed: {
    title: 'Agreement Successfully Signed',
    subject: 'Your Ryer Loans Agreement Has Been Signed',
    message:
      'We have successfully received your signed loan agreement. Your application will now proceed to the next stage of processing.',
    color: '#16a34a',
    icon: '&#128220;',
  },

  verification_deposit_sent: {
    title: 'Verification Transaction Initiated',
    subject: 'Ryer Loans: Verification Transaction Initiated',
    message: '',
    customBody: (details) => `
      <p style="color:#374151;font-size:16px;">
        Hi ${details.firstName},
      </p>

      <p style="color:#374151;font-size:16px;">
        A bank verification transaction has been initiated as
        part of the verification process for your application.
      </p>

      <div style="
        background:#eff6ff;
        border:1px solid #93c5fd;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#1e40af;font-size:15px;margin:0;">
          Watch your verified bank account for two small deposits, then
          come back and tell us the exact amounts. They usually arrive
          within 1&ndash;3 business days.
        </p>
      </div>

      ${actionButton(details.actionUrl, 'Confirm My Deposit Amounts')}

      <p style="color:#374151;font-size:16px;">
        Ryer Loans will never ask you to send money, buy a gift card, or
        pay a fee before your loan is funded. These deposits go
        <strong>into</strong> your account, never out of it.
      </p>

      <p style="color:#374151;font-size:16px;">
        Application ID:
        <strong>${details.applicationId}</strong>
      </p>

      <p style="color:#374151;font-size:16px;">
        If you do not recognize a transaction or have questions
        about the verification process, please contact Ryer Loans
        through the official support channel.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Best regards,<br/>
        The Ryer Loans Verification Team
      </p>
    `,
    color: '#2563eb',
    icon: '&#128176;',
  },

  verification_deposit_confirmed: {
    title: 'Bank Verification Confirmed',
    subject: 'Bank Verification Confirmed - Ryer Loans',
    message:
      'Your verification transaction has been successfully confirmed. Your application can now continue to the next stage of processing.',
    color: '#16a34a',
    icon: '&#9989;',
  },

  underwriting: {
    title: 'Application in Final Review',
    subject: 'Your Ryer Loans Application Is in Final Review',
    message:
      'Your application has reached the underwriting stage. Our team is completing the final review of your application and will notify you when a decision is available.',
    color: '#7c3aed',
    icon: '&#128202;',
  },

  approved: {
    title: 'Loan Application Approved',
    subject: 'Great News! Your Ryer Loans Application Has Been Approved',
    message: '',
    customBody: (details, formattedAmount) => `
      <p style="color:#374151;font-size:16px;">
        Congratulations ${details.firstName}!
      </p>

      <p style="color:#374151;font-size:16px;">
        We are pleased to inform you that your Ryer Loans
        application has been approved for further processing.
      </p>

      <div style="
        background:#f0fdf4;
        border:1px solid #86efac;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#166534;font-size:15px;margin:0;">
          <strong>Application Amount:</strong>
          ${formattedAmount}
        </p>
      </div>

      <p style="color:#374151;font-size:16px;">
        Please review any remaining documents or instructions
        provided through your secure application portal.
      </p>

      <p style="color:#374151;font-size:16px;">
        Your Application ID is
        <strong>${details.applicationId}</strong>.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Best regards,<br/>
        The Ryer Loans Team
      </p>
    `,
    color: '#16a34a',
    icon: '&#127881;',
  },

  funded: {
    title: 'Loan Funded',
    subject: 'Great News! Your Ryer Loans Loan Has Been Funded',
    message: '',
    customBody: (details, formattedAmount) => `
      <p style="color:#374151;font-size:16px;">
        Hi ${details.firstName},
      </p>

      <p style="color:#374151;font-size:16px;">
        Congratulations! Your loan has been successfully funded.
      </p>

      <div style="
        background:#f0fdf4;
        border:1px solid #86efac;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#166534;font-size:15px;margin:0;">
          <strong>Funded Amount:</strong>
          ${formattedAmount}
        </p>
      </div>

      <p style="color:#374151;font-size:16px;">
        Funds will be delivered according to the funding method
        and timeline specified in your signed agreement.
      </p>

      <p style="color:#374151;font-size:16px;">
        Please keep your loan agreement for your records.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Thank you for choosing Ryer Loans.
        <br/><br/>
        Sincerely,<br/>
        The Ryer Loans Team
      </p>
    `,
    color: '#16a34a',
    icon: '&#128176;',
  },

  declined: {
    title: 'Application Update',
    subject: 'Important Update Regarding Your Ryer Loans Application',
    message: '',
    customBody: (details) => `
      <p style="color:#374151;font-size:16px;">
        Hi ${details.firstName},
      </p>

      <p style="color:#374151;font-size:16px;">
        Thank you for applying with Ryer Loans.
      </p>

      <p style="color:#374151;font-size:16px;">
        After completing our review, we are unable to approve
        your loan application at this time.
      </p>

      <div style="
        background:#fef2f2;
        border:1px solid #fca5a5;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#991b1b;font-size:15px;margin:0;">
          Please refer to any separate adverse action or decision
          notice provided to you for additional information.
        </p>
      </div>

      <p style="color:#374151;font-size:16px;">
        We appreciate your interest in Ryer Loans.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Sincerely,<br/>
        The Ryer Loans Team
      </p>
    `,
    color: '#dc2626',
    icon: '&#10060;',
  },

  withdrawn: {
    title: 'Application Withdrawn',
    subject: 'Your Ryer Loans Application Has Been Withdrawn',
    message: '',
    customBody: (details) => `
      <p style="color:#374151;font-size:16px;">
        Hi ${details.firstName},
      </p>

      <p style="color:#374151;font-size:16px;">
        Your Ryer Loans application has been marked as withdrawn
        and will no longer proceed through the application process.
      </p>

      <div style="
        background:#f3f4f6;
        border:1px solid #d1d5db;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#374151;font-size:15px;margin:0;">
          <strong>Application ID:</strong>
          ${details.applicationId}
        </p>
      </div>

      <p style="color:#374151;font-size:16px;">
        If you believe this status was applied in error,
        please contact our support team.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Best regards,<br/>
        The Ryer Loans Team
      </p>
    `,
    color: '#6b7280',
    icon: '&#128274;',
  },

  expired: {
    title: 'Application Expired',
    subject: 'Your Ryer Loans Application Has Expired',
    message: '',
    customBody: (details) => `
      <p style="color:#374151;font-size:16px;">
        Hi ${details.firstName},
      </p>

      <p style="color:#374151;font-size:16px;">
        Your Ryer Loans application has expired because the
        required steps were not completed within the applicable
        timeframe.
      </p>

      <div style="
        background:#fef2f2;
        border:1px solid #fca5a5;
        border-radius:8px;
        padding:18px;
        margin:20px 0;
      ">
        <p style="color:#991b1b;font-size:15px;margin:0;">
          <strong>Application ID:</strong>
          ${details.applicationId}
        </p>
      </div>

      <p style="color:#374151;font-size:16px;">
        If you still need financing, you may submit a new
        application subject to our current eligibility requirements.
      </p>

      <p style="color:#374151;font-size:16px;margin-top:24px;">
        Best regards,<br/>
        The Ryer Loans Team
      </p>
    `,
    color: '#6b7280',
    icon: '&#9200;',
  },
};

/*
 * Aliases, so a template can be reached by both the name §8.4 gives the email
 * and the name §6 gives the status.
 *
 * Two different callers ask for these by two different names: the action
 * buttons pass the §8.4 key, while `updateStatus` and the expiry job pass a
 * bare ApplicationStatus. Aliasing rather than duplicating means the borrower
 * reads identical copy either way, and `hasStatusTemplate` — which is what
 * decides whether the §8.3 Emails panel offers a resend — answers true for
 * every key that has ever been written to email_log.
 */
statusConfig.bank_verification_pending =
  statusConfig.bank_verification_requested;
statusConfig.application_withdrawn = statusConfig.withdrawn;

/* =========================================================
   EMAIL SERVICE
========================================================= */

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: Transporter;

  constructor(
    private readonly configService: ConfigService,
    private readonly suppressionService: SuppressionService,
    private readonly emailLogService: EmailLogService,
  ) {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT', 587);
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');

    if (!host) {
      throw new Error('SMTP_HOST is not configured');
    }

    if (!user) {
      throw new Error('SMTP_USER is not configured');
    }

    if (!pass) {
      throw new Error('SMTP_PASS is not configured');
    }

    this.logger.log(`SMTP Host: ${host}`);
    this.logger.log(`SMTP Port: ${port}`);
    this.logger.log(`SMTP User: ${user}`);

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: false,
      requireTLS: true,
      auth: {
        user,
        pass,
      },
    });
  }

  /* =========================================================
     GENERIC EMAIL
  ========================================================= */

  async sendEmail({
    to,
    subject,
    html,
    text,
    campaignId = process.env.MAILERCLOUD_CAMPAIGN_ID,
    transactional = true,
    templateKey,
    applicationId,
  }: SendEmailOptions): Promise<SendEmailResult> {
    /*
     * §7.3: the suppression list is enforced BEFORE the send, not after the
     * provider bounces it back at us.
     */
    const suppression = await this.suppressionService.check(to, transactional);

    if (suppression.suppressed) {
      this.logger.warn(
        `Skipping ${templateKey ?? 'email'} to suppressed address (${suppression.reason})`,
      );

      await this.recordLog({
        applicationId,
        templateKey,
        to,
        subject,
        status: 'cancelled',
        cancelledReason: `suppressed:${suppression.reason}`,
      });

      return { sent: false, skippedReason: `suppressed:${suppression.reason}` };
    }

    const headers: Record<string, string> = {};

    if (campaignId) {
      headers['mld-track-campaign-id'] = campaignId;
      headers['mld-track-opens'] = 'true';
      headers['mld-track-clicks'] = 'true';
      headers['mld-track-inbox'] = 'true';
    }

    /*
     * RFC 8058 one-click unsubscribe on non-transactional mail (§7.3).
     * Transactional notices must not carry it — an unsubscribe cannot opt a
     * borrower out of their own adverse action notice.
     */
    if (!transactional) {
      const unsubscribeUrl = buildUnsubscribeUrl(to);
      const unsubscribeMailbox = process.env.UNSUBSCRIBE_EMAIL;

      headers['List-Unsubscribe'] = unsubscribeMailbox
        ? `<${unsubscribeUrl}>, <mailto:${unsubscribeMailbox}?subject=unsubscribe>`
        : `<${unsubscribeUrl}>`;

      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    const log = await this.recordLog({
      applicationId,
      templateKey,
      to,
      subject,
      status: 'queued',
    });

    try {
      const info = await this.transporter.sendMail({
        from: `"${process.env.FROM_NAME}" <${process.env.FROM_EMAIL}>`,
        to,
        subject,
        html,
        text,
        headers,
      });

      this.logger.log(`Email sent to ${to}: ${info.messageId}`);

      if (log) {
        await this.emailLogService
          .markAsSent(log.id, info.messageId)
          .catch((error: unknown) =>
            this.logger.error(
              `Failed to mark email_log ${log.id} as sent`,
              error instanceof Error ? error.stack : String(error),
            ),
          );
      }

      return { sent: true, providerMessageId: info.messageId };
    } catch (error: unknown) {
      this.logger.error(
        'SMTP send failed',
        error instanceof Error ? error.stack : String(error),
      );

      if (log) {
        await log.update({ status: 'failed' }).catch(() => undefined);
      }

      throw error;
    }
  }

  /**
   * email_log is an audit trail, not a precondition for delivery — a failure to
   * write it must never stop the mail from going out.
   */
  private async recordLog(params: {
    applicationId?: string;
    templateKey?: string;
    to: string;
    subject: string;
    status: 'queued' | 'cancelled';
    cancelledReason?: string;
  }) {
    try {
      const log = await this.emailLogService.recordQueuedEmail({
        application_id: params.applicationId ?? null,
        template_key: params.templateKey ?? 'ad_hoc',
        to_email: params.to,
        subject: params.subject,
        scheduled_for: new Date(),
      });

      if (params.status === 'cancelled') {
        await log.update({
          status: 'cancelled',
          cancelled_reason: params.cancelledReason ?? null,
        });
      }

      return log;
    } catch (error: unknown) {
      this.logger.error(
        'Failed to write email_log entry',
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  /* =========================================================
     APPLICATION STATUS UPDATE EMAIL
  ========================================================= */

  /**
   * Returns the send result rather than void: a caller that offers a "resend"
   * button has to be able to tell a delivered send from an unknown template or
   * a suppressed address, and cannot infer either from a resolved promise.
   */
  async sendStatusUpdateEmail(
    details: StatusUpdateDetails,
  ): Promise<SendEmailResult> {
    const { applicationId, firstName, email, loanAmount, status } = details;

    const templateKey = details.templateKey ?? status;
    const config = statusConfig[templateKey];

    if (!config) {
      this.logger.warn(`No email template configured for "${templateKey}"`);

      return { sent: false, skippedReason: 'no_template' };
    }

    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(loanAmount);

    const subject =
      details.subjectOverride?.trim() ||
      config.subject ||
      `${config.title} - ID: ${applicationId} | Ryer Loans`;

    const messageHtml = details.bodyOverride?.trim()
      ? details.bodyOverride
      : config.customBody
        ? config.customBody(details, formattedAmount)
        : `
        <p style="color:#374151;font-size:16px;">
          Hi ${firstName},
        </p>

        <p style="color:#374151;font-size:16px;">
          ${config.message ?? ''}
        </p>
      `;

    const html = `
      <div style="
        font-family:Arial,sans-serif;
        max-width:600px;
        margin:0 auto;
        padding:20px;
      ">

        <div style="
          background:#F0FFF4;
          padding:20px;
          border-radius:8px 8px 0 0;
          text-align:center;
        ">
          <h1 style="
            margin:0;
            font-size:32px;
            font-weight:700;
            color:#14532d;
          ">
            Ryer Loans
          </h1>
        </div>

        <div style="
          border:1px solid #e5e7eb;
          border-top:none;
          padding:30px;
          border-radius:0 0 8px 8px;
        ">

          <div style="
            text-align:center;
            margin-bottom:20px;
          ">
            <span style="font-size:48px;">
              ${config.icon}
            </span>
          </div>

          <h2 style="
            color:${config.color};
            margin-top:0;
            text-align:center;
          ">
            ${config.title}
          </h2>

          ${messageHtml}

          <div style="
            background:#f3f4f6;
            border-radius:8px;
            padding:20px;
            margin:20px 0;
          ">

            <table style="
              width:100%;
              border-collapse:collapse;
            ">

              <tr>
                <td style="
                  padding:8px 0;
                  color:#6b7280;
                  font-size:14px;
                ">
                  Application ID
                </td>

                <td style="
                  padding:8px 0;
                  color:#111827;
                  font-size:14px;
                  font-weight:bold;
                  text-align:right;
                ">
                  ${applicationId}
                </td>
              </tr>

              <tr>
                <td style="
                  padding:8px 0;
                  color:#6b7280;
                  font-size:14px;
                ">
                  Loan Amount
                </td>

                <td style="
                  padding:8px 0;
                  color:#111827;
                  font-size:14px;
                  font-weight:bold;
                  text-align:right;
                ">
                  ${formattedAmount}
                </td>
              </tr>

            </table>
          </div>

          ${
            /*
             * The wrapper-level verification CTA, shown on any send that leaves
             * the file waiting on bank verification.
             *
             * Gated on a minted link rather than on the status. It used to be
             * gated on `status === 'bank_verification_pending'` and built its
             * own href from FRONTEND_URL and the applicationId — which pointed
             * at /verify-bank (not a route), interpolated `undefined` whenever
             * FRONTEND_URL was unset, and offered a credential-free link into a
             * flow that advances the file. Rendering nothing beats rendering a
             * button that cannot work.
             */
            status === 'bank_verification_pending' && details.actionUrl
              ? `
                <div style="
                  text-align:center;
                  margin:25px 0;
                ">
                  <a
                    href="${details.actionUrl}"
                    style="
                      background:#1a56db;
                      color:#ffffff;
                      padding:12px 30px;
                      border-radius:6px;
                      text-decoration:none;
                      font-size:16px;
                      font-weight:bold;
                      display:inline-block;
                    "
                  >
                    Verify Bank Account
                  </a>
                </div>
              `
              : ''
          }

          <hr style="
            border:none;
            border-top:1px solid #e5e7eb;
            margin:20px 0;
          ">

          <div style="
            text-align:center;
            padding:10px 0;
          ">
            <p style="
              color:#374151;
              font-size:14px;
              margin:5px 0;
            ">
              <strong>Phone:</strong>
              <a
                href="tel:+17472005220"
                style="color:#1a56db;text-decoration:none;"
              >
                (747) 200-5220
              </a>
            </p>

            <p style="
              color:#374151;
              font-size:14px;
              margin:5px 0;
            ">
              <strong>Website:</strong>
              <a
                href="https://www.ryerloans.com"
                style="color:#1a56db;text-decoration:none;"
              >
                www.ryerloans.com
              </a>
            </p>
          </div>

          <p style="
            color:#9ca3af;
            font-size:12px;
            text-align:center;
          ">
            This is an automated email from Ryer Loans.
            Please do not reply to this email.
          </p>

        </div>
      </div>
    `;

    return this.sendEmail({
      to: email,
      subject,
      html,
      text: `Your Ryer Loans application status has been updated to ${status}. Application ID: ${applicationId}`,
      // Status notices are transactional: a borrower who unsubscribed from
      // reminders must still receive their agreement, decision and funding mail.
      transactional: true,
      templateKey,
      applicationId: details.applicationUuid,
    });
  }

  /* =========================================================
     REVIEW INVITATION (post-funding)
  ========================================================= */

  /**
   * §11 step 1 — the `review_request` email, sent once a loan is funded.
   *
   * Non-transactional, and that is the whole point of it living here rather
   * than going out through sendStatusUpdateEmail: a status notice bypasses the
   * suppression list, because a borrower cannot unsubscribe from their own
   * adverse action notice. Asking that same borrower to praise us in public is
   * not a notice — it is marketing, so it honours the unsubscribe, carries the
   * RFC 8058 one-click header, and skips an address that bounced or complained.
   *
   * The button is the email. Without the minted token there is no form to send
   * anyone to, so `reviewUrl` is required rather than defaulted.
   */
  async sendReviewInvitationEmail(
    details: ReviewInvitationDetails,
  ): Promise<SendEmailResult> {
    const { firstName, email, applicationId, reviewUrl, expiresAt } = details;

    const subject =
      details.subjectOverride?.trim() ||
      `How did we do, ${firstName}? — ${BRAND_NAME}`;

    const expiryLabel = expiresAt.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

    const body =
      details.bodyOverride?.trim() ||
      `
        <p style="color:#374151;font-size:16px;">
          Hi ${firstName},
        </p>

        <p style="color:#374151;font-size:16px;">
          Your loan is funded and the file is closed — thank you for
          borrowing with ${BRAND_NAME}.
        </p>

        <p style="color:#374151;font-size:16px;">
          If you have two minutes, we would like to hear how it went.
          Your rating and a few words help the next borrower decide
          whether we are worth calling.
        </p>
      `;

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:20px;">

        <div style="background:#F0FFF4;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
          <h1 style="margin:0;font-size:32px;font-weight:700;color:#14532d;">
            ${BRAND_NAME}
          </h1>
        </div>

        <div style="border:1px solid #e5e7eb;border-top:none;padding:30px;border-radius:0 0 8px 8px;">

          <div style="text-align:center;margin-bottom:20px;">
            <span style="font-size:48px;">&#11088;</span>
          </div>

          <h2 style="color:#16a34a;margin-top:0;text-align:center;">
            Tell us how we did
          </h2>

          ${body}

          <div style="text-align:center;margin:28px 0;">
            <a
              href="${reviewUrl}"
              style="
                background:#1a56db;
                color:#ffffff;
                padding:12px 30px;
                border-radius:6px;
                text-decoration:none;
                font-size:16px;
                font-weight:bold;
                display:inline-block;
              "
            >
              Leave My Review
            </a>
          </div>

          <p style="color:#6b7280;font-size:14px;text-align:center;">
            This link is unique to you and works until ${expiryLabel}.
          </p>

          <div style="background:#f9fafb;border-radius:8px;padding:14px;margin:20px 0;">
            <p style="color:#6b7280;font-size:14px;margin:0;">
              <strong>Application ID:</strong> ${applicationId}
            </p>
          </div>

          <p style="color:#374151;font-size:15px;">
            Nothing is published without your say-so: you choose the name that
            appears with your review, and you tick the box that allows us to
            show it at all. Reviews are never a condition of anything on your
            loan, and we will never ask you to pay a fee — if anyone does,
            call us on ${SUPPORT_PHONE_DISPLAY}.
          </p>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">

          <p style="color:#374151;font-size:14px;text-align:center;">
            Questions? Call ${PHONE_LINK}.
          </p>

        </div>
      </div>
    `;

    return this.sendEmail({
      to: email,
      subject,
      html,
      text:
        `Hi ${firstName}, thank you for borrowing with ${BRAND_NAME}. ` +
        `Tell us how we did: ${reviewUrl} (link valid until ${expiryLabel}).`,
      /*
       * Marketing, not a notice — see the doc comment. This is what routes the
       * send through the suppression check and attaches List-Unsubscribe.
       */
      transactional: false,
      templateKey: 'review_request',
      applicationId: details.applicationUuid,
    });
  }

  async sendApplicationConfirmationEmail(
    details: ApplicationDetails,
  ): Promise<void> {
    const {
      applicationId,
      firstName,
      lastName,
      email,
      loanAmount,
      loanPurpose,
    } = details;

    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(loanAmount);

    const purposeLabel = loanPurpose
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const html = `
      <div style="
        font-family: Arial, sans-serif;
        max-width: 600px;
        margin: 0 auto;
        padding: 20px;
      ">

        <div style="
          background: #F0FFF4;
          padding: 20px;
          border-radius: 8px 8px 0 0;
          text-align: center;
        ">
          <h1 style="
            margin: 0;
            font-size: 32px;
            font-weight: 700;
            color: #14532d;
          ">
            Ryer Loans
          </h1>
        </div>

        <div style="
          border: 1px solid #e5e7eb;
          border-top: none;
          padding: 30px;
          border-radius: 0 0 8px 8px;
        ">

          <h2 style="color: #111827;">
            Application Received!
          </h2>

          <p style="color: #374151; font-size: 16px;">
            Hi ${firstName},
          </p>

          <p style="color: #374151; font-size: 16px;">
            Thank you for submitting your loan application.
            We have received your application and it is now being processed.
          </p>

          <div style="
            background: #f3f4f6;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
          ">

            <h3 style="color: #111827;">
              Application Details
            </h3>

            <table style="
              width: 100%;
              border-collapse: collapse;
            ">

              <tr>
                <td style="padding: 8px 0; color: #6b7280;">
                  Application ID
                </td>

                <td style="
                  padding: 8px 0;
                  color: #111827;
                  font-weight: bold;
                  text-align: right;
                ">
                  ${applicationId}
                </td>
              </tr>

              <tr>
                <td style="padding: 8px 0; color: #6b7280;">
                  Applicant Name
                </td>

                <td style="
                  padding: 8px 0;
                  color: #111827;
                  text-align: right;
                ">
                  ${firstName} ${lastName}
                </td>
              </tr>

              <tr>
                <td style="padding: 8px 0; color: #6b7280;">
                  Loan Amount
                </td>

                <td style="
                  padding: 8px 0;
                  color: #111827;
                  font-weight: bold;
                  text-align: right;
                ">
                  ${formattedAmount}
                </td>
              </tr>

              <tr>
                <td style="padding: 8px 0; color: #6b7280;">
                  Loan Purpose
                </td>

                <td style="
                  padding: 8px 0;
                  color: #111827;
                  text-align: right;
                ">
                  ${purposeLabel}
                </td>
              </tr>


            </table>
          </div>

          <div style="
            background: #eff6ff;
            border: 1px solid #93c5fd;
            border-radius: 8px;
            padding: 15px;
            margin: 20px 0;
          ">
            <p style="
              color: #1e40af;
              font-size: 14px;
              margin: 0;
            ">
              <strong>Next Step:</strong>
              Please follow the instructions provided in your
              application portal to continue processing your application.
            </p>
          </div>

          <p style="color: #374151; font-size: 14px;">
            Please save your Application ID
            <strong>${applicationId}</strong>
            for future reference.
          </p>

          <hr style="
            border: none;
            border-top: 1px solid #e5e7eb;
            margin: 20px 0;
          ">

          <div style="
            text-align: center;
            padding: 10px 0;
          ">

            <p style="color: #374151; font-size: 14px;">
              <strong>Phone:</strong>
              <a
                href="tel:+17472005220"
                style="color: #1a56db; text-decoration: none;"
              >
                (747) 200-5220
              </a>
            </p>

            <p style="color: #374151; font-size: 14px;">
              <strong>Website:</strong>
              <a
                href="https://www.ryerloans.com"
                style="color: #1a56db; text-decoration: none;"
              >
                www.ryerloans.com
              </a>
            </p>

          </div>

          <p style="
            color: #9ca3af;
            font-size: 12px;
            text-align: center;
          ">
            This is an automated email from Ryer Loans.
            Please do not reply to this email.
          </p>

        </div>
      </div>
    `;

    await this.sendEmail({
      to: email,
      subject: `Application Received - ID: ${applicationId} | Ryer Loans`,
      html,
      text: `Application ${applicationId} has been received.`,
      transactional: true,
      templateKey: 'application_received',
      applicationId: details.applicationUuid,
    });
  }
}
