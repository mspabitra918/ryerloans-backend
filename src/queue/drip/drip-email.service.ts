// src/queue/drip/drip-email.service.ts
//
// The nine drip templates from §7.3: call_reminder_1..3 and
// bank_verification_1..6.
//
// Every bank-verification email has its own subject line and its own angle.
// The brief is explicit about why: "do not send the identical email six times;
// that is a spam-complaint generator." The same goes for the call reminders,
// which escalate in urgency without ever becoming threatening.

import { Injectable } from '@nestjs/common';

import { EmailService } from '../../email/email.service';
import {
  BRAND_BLUE,
  BRAND_GREEN,
  HOME_URL,
  HOME_URL_DISPLAY,
  PHONE_LINK,
  SUPPORT_HOURS,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_PHONE_HREF,
  verifyBankUrl,
} from '../../email/brand.constants';
import { buildUnsubscribeUrl } from '../../email/unsubscribe.util';

import type { DripEmailDetails } from './drip.types';

type CtaTarget = 'verify' | 'phone' | 'home';

interface DripTemplate {
  subject: string;
  /** Short line under the header — gives each send a distinct visual identity. */
  preheader: string;
  accent: string;
  body: string[];
  cta: { label: string; target: CtaTarget };
  signOff: string[];
}

/* =========================================================
   CALL-IN SEQUENCE — 3 emails, escalating, never threatening
========================================================= */

const CALL_REMINDER_1: DripTemplate = {
  subject: 'One quick call finishes your application',
  preheader: 'A five-minute call is all that is left.',
  accent: BRAND_BLUE,
  body: [
    'Your application is safely in our system and a member of our underwriting team has it open.',
    `Before we can go further, we need to confirm a few details with you directly. We do not approve loans from a form alone — a real person reviews every file, and that review starts with a short call.`,
    `Give us a call at <strong>${PHONE_LINK}</strong> whenever it suits you.<br /><em>${SUPPORT_HOURS}</em>`,
    'Have your Application ID handy and the call should take about five minutes.',
  ],
  cta: { label: `Call ${SUPPORT_PHONE_DISPLAY}`, target: 'phone' },
  signOff: ['Best regards,', 'The Underwriting Team at Ryer Loans'],
};

const CALL_REMINDER_2: DripTemplate = {
  subject: 'Still holding your file — can we talk today?',
  preheader: 'Your application is paused until we speak.',
  accent: '#f59e0b',
  body: [
    'We tried to reach the next stage of your application yesterday, but we still have not been able to speak with you.',
    'Your file stays exactly where it is until that conversation happens. Nothing has been declined and nothing has been lost — it is simply waiting.',
    `The fastest way to restart it is a call to ${PHONE_LINK}.`,
    'If it is easier, call us and ask for a callback window that works for you. We would rather work around your schedule than let the file sit.',
  ],
  cta: { label: `Call ${SUPPORT_PHONE_DISPLAY}`, target: 'phone' },
  signOff: ['Best,', 'The Underwriting Team at Ryer Loans'],
};

const CALL_REMINDER_3: DripTemplate = {
  subject: 'Last reminder about your Ryer Loans application',
  preheader: 'This is our final call reminder.',
  accent: '#dc2626',
  body: [
    'This is the last reminder we will send about scheduling your review call.',
    'We are not closing your application today, and this has no effect on your credit. But without a call we cannot move it forward, and after a period of inactivity applications do expire on their own.',
    `If you still want the loan, call ${PHONE_LINK} and we will pick up where we left off.`,
    'If your circumstances have changed and you no longer need the funds, you can simply ignore this message — no further action is needed on your part.',
  ],
  cta: { label: `Call ${SUPPORT_PHONE_DISPLAY}`, target: 'phone' },
  signOff: ['Sincerely,', 'The Underwriting Team at Ryer Loans'],
};

/* =========================================================
   BANK VERIFICATION SEQUENCE — 6 emails, six different angles
========================================================= */

// #1 — the plain ask.
const BANK_VERIFICATION_1: DripTemplate = {
  subject: 'Next step: connect your bank account',
  preheader: 'One secure step left on your application.',
  accent: BRAND_BLUE,
  body: [
    'Thanks for applying with Ryer Loans. There is one step left before we can finish reviewing your file: verifying the bank account you want the funds sent to.',
    'The link below opens a secure connection to your bank. It takes under a minute.',
    'Once it is done, your application moves straight into review — no further action needed from you.',
  ],
  cta: { label: 'Verify My Bank Account', target: 'verify' },
  signOff: ['Best,', 'The Underwriting Team at Ryer Loans'],
};

// #2 — how the security actually works (the most common objection).
const BANK_VERIFICATION_2: DripTemplate = {
  subject: 'How we verify your account (and what we never see)',
  preheader: 'We never see or store your banking password.',
  accent: BRAND_GREEN,
  body: [
    'A lot of people pause at this step, so it is worth explaining exactly what happens when you click the link.',
    'You connect to your bank through an encrypted session run by our verification provider. <strong>Ryer Loans never sees or stores your online banking username or password.</strong> What we receive back is confirmation that the account exists, that it is open, and that it belongs to you.',
    'We use it for one purpose: to know where to send your money, and to be sure it is going to the right person.',
    'If you would rather walk through it with someone on the phone, we are happy to do that instead.',
  ],
  cta: { label: 'See How It Works', target: 'verify' },
  signOff: ['Best,', 'Ryer Loans Customer Support'],
};

// #3 — what it unblocks.
const BANK_VERIFICATION_3: DripTemplate = {
  subject: 'What happens right after you verify',
  preheader: 'Here is the rest of the process, start to finish.',
  accent: BRAND_BLUE,
  body: [
    'You have one step left, so here is what comes after it:',
    `<strong>1.</strong> You verify your bank account.<br />
     <strong>2.</strong> Your file goes to an underwriter for review.<br />
     <strong>3.</strong> If approved, we send your loan agreement to sign electronically.<br />
     <strong>4.</strong> We send a small verification deposit you confirm.<br />
     <strong>5.</strong> Funds are released to the account you verified.`,
    'Every stage after the first one is on us. The only thing currently waiting on you is that first step.',
  ],
  cta: { label: 'Complete Step 1', target: 'verify' },
  signOff: ['Best,', 'The Underwriting Team at Ryer Loans'],
};

// #4 — troubleshooting, for people who tried and failed.
const BANK_VERIFICATION_4: DripTemplate = {
  subject: 'Trouble connecting your bank? Read this',
  preheader: 'The three things that usually go wrong.',
  accent: '#f59e0b',
  body: [
    'If you started the bank verification and it did not go through, you are not alone. Three things account for almost every failed attempt:',
    `<strong>Your bank asked for a security code.</strong> Some institutions send a one-time code by text before allowing a connection. Keep your phone nearby when you start.<br /><br />
     <strong>You picked the wrong institution.</strong> Regional banks and credit unions often have several near-identical entries in the list. Search by the exact name on your statement.<br /><br />
     <strong>The session timed out.</strong> The secure window closes after a few minutes of inactivity. Starting over is safe and will not create a duplicate application.`,
    `Still stuck? Call ${PHONE_LINK} and we will stay on the line while you do it.`,
  ],
  cta: { label: 'Try Verification Again', target: 'verify' },
  signOff: ['Best,', 'Ryer Loans Customer Support'],
};

// #5 — the alternative route, for people who will not use Plaid at all.
const BANK_VERIFICATION_5: DripTemplate = {
  subject: 'Prefer not to link your bank online?',
  preheader: 'There is more than one way to verify.',
  accent: BRAND_GREEN,
  body: [
    'Some people would simply rather not connect their bank through a website, and that is a completely reasonable position.',
    'If that is you, call us. We can walk you through a manual verification instead, where we send two small deposits to your account and you confirm the amounts once they arrive. It takes a couple of days longer, but it works.',
    `Call ${PHONE_LINK} and ask for manual bank verification.<br /><em>${SUPPORT_HOURS}</em>`,
    'If you would still prefer the instant option, the secure link below is always available.',
  ],
  cta: { label: 'Use The Instant Option', target: 'verify' },
  signOff: ['Best,', 'Ryer Loans Customer Support'],
};

// #6 — final, honest about what happens next.
const BANK_VERIFICATION_6: DripTemplate = {
  subject: 'Final reminder: your application is waiting on one step',
  preheader: 'The last email we will send about this step.',
  accent: '#dc2626',
  body: [
    'This is the last reminder we will send about verifying your bank account.',
    'Your application has not been declined and nothing here affects your credit score. It is simply paused, and it will expire on its own if it stays that way.',
    'If you still want to move forward, the link below takes under a minute. If you would rather talk to someone first, or verify a different way, call us and we will sort it out.',
    `${PHONE_LINK} · ${SUPPORT_HOURS}`,
  ],
  cta: { label: 'Verify My Bank Account', target: 'verify' },
  signOff: ['Sincerely,', 'The Underwriting Team at Ryer Loans'],
};

/** Keyed by the §7.3 template_key, which is also what lands in email_log. */
const TEMPLATES: Record<string, DripTemplate> = {
  call_reminder_1: CALL_REMINDER_1,
  call_reminder_2: CALL_REMINDER_2,
  call_reminder_3: CALL_REMINDER_3,

  bank_verification_1: BANK_VERIFICATION_1,
  bank_verification_2: BANK_VERIFICATION_2,
  bank_verification_3: BANK_VERIFICATION_3,
  bank_verification_4: BANK_VERIFICATION_4,
  bank_verification_5: BANK_VERIFICATION_5,
  bank_verification_6: BANK_VERIFICATION_6,
};

export function hasDripTemplate(templateKey: string): boolean {
  return templateKey in TEMPLATES;
}

@Injectable()
export class DripEmailService {
  constructor(private readonly emailService: EmailService) {}

  private ctaHref(target: CtaTarget, actionUrl?: string): string {
    switch (target) {
      case 'verify':
        /*
         * The minted single-use link when the caller has one. The fallback is
         * the explainer page, not the Plaid flow — a template rendered outside
         * the queue has no token, and there is no other way to open
         * verification.
         */
        return actionUrl ?? verifyBankUrl();
      case 'phone':
        return SUPPORT_PHONE_HREF;
      case 'home':
        return HOME_URL;
    }
  }

  private renderPlainText(
    template: DripTemplate,
    details: DripEmailDetails,
  ): string {
    const stripped = template.body
      .map((paragraph) =>
        paragraph
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .join('\n\n');

    /*
     * The plain-text part carried no link at all, which made a "verify your
     * bank account" reminder unactionable for anyone reading text — the CTA is
     * the entire point of the send. `phone` and `home` targets are already in
     * the sign-off, so only a real destination is worth repeating.
     */
    const href = this.ctaHref(template.cta.target, details.actionUrl);

    const cta =
      template.cta.target === 'phone'
        ? []
        : [`${template.cta.label}: ${href}`, ''];

    return [
      `Hi ${details.firstName},`,
      '',
      stripped,
      '',
      ...cta,
      `Application ID: ${details.applicationId}`,
      `Questions? Call ${SUPPORT_PHONE_DISPLAY}`,
      '',
      template.signOff.join('\n'),
      '',
      `Unsubscribe from reminder emails: ${buildUnsubscribeUrl(details.email)}`,
    ].join('\n');
  }

  private renderDripEmail(
    template: DripTemplate,
    details: DripEmailDetails,
  ): string {
    const { applicationId, firstName, loanAmount } = details;

    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(loanAmount);

    const paragraphs = template.body
      .map(
        (paragraph) =>
          `<p style="color:#374151;font-size:16px;line-height:1.6;">${paragraph}</p>`,
      )
      .join('\n');

    const unsubscribeUrl = buildUnsubscribeUrl(details.email);

    return `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">

        <div style="background:#F0FFF4;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
          <h1 style="margin:0;font-size:32px;font-weight:700;color:${BRAND_GREEN};letter-spacing:0.5px;">
            Ryer Loans
          </h1>
          <p style="margin:6px 0 0;color:#166534;font-size:13px;">
            ${template.preheader}
          </p>
        </div>

        <div style="border:1px solid #e5e7eb;border-top:none;padding:30px;border-radius:0 0 8px 8px;">

          <p style="color:#374151;font-size:16px;">Hi ${firstName},</p>

          ${paragraphs}

          <div style="background:#f3f4f6;border-radius:8px;padding:20px;margin:20px 0;">
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="padding:8px 0;color:#6b7280;font-size:14px;">Application ID</td>
                <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:bold;text-align:right;">
                  ${applicationId}
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#6b7280;font-size:14px;">Amount Requested</td>
                <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:bold;text-align:right;">
                  ${formattedAmount}
                </td>
              </tr>
            </table>
          </div>

          <div style="text-align:center;margin:25px 0;">
            <a
              href="${this.ctaHref(template.cta.target, details.actionUrl)}"
              style="background:${template.accent};color:#ffffff;padding:12px 30px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:bold;display:inline-block;"
            >
              ${template.cta.label}
            </a>
          </div>

          <p style="color:#374151;font-size:16px;margin-top:24px;">
            ${template.signOff.join('<br />')}
          </p>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">

          <div style="text-align:center;padding:10px 0;">
            <p style="color:#374151;font-size:14px;margin:5px 0;">
              <strong>Phone:</strong> ${PHONE_LINK}
            </p>
            <p style="color:#374151;font-size:14px;margin:5px 0;">
              <strong>Website:</strong>
              <a href="${HOME_URL}" style="color:${BRAND_BLUE};text-decoration:none;">
                ${HOME_URL_DISPLAY}
              </a>
            </p>
          </div>

          <p style="color:#9ca3af;font-size:12px;text-align:center;margin-bottom:4px;">
            This is an automated reminder from Ryer Loans. Please do not reply to this email.
          </p>

         

        </div>
      </div>
    `;
  }

  //  <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:0;">
  //           <a href="${unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline;">
  //             Unsubscribe from reminder emails
  //           </a>
  //         </p>

  /**
   * Send one drip step. Marked non-transactional so it carries the RFC 8058
   * List-Unsubscribe header and respects unsubscribes.
   *
   * Returns false when the send was suppressed rather than delivered.
   */
  async sendDripEmail(
    templateKey: string,
    details: DripEmailDetails,
  ): Promise<boolean> {
    const template = TEMPLATES[templateKey];

    if (!template) {
      throw new Error(`No drip template registered for "${templateKey}"`);
    }

    const result = await this.emailService.sendEmail({
      to: details.email,
      subject: template.subject,
      html: this.renderDripEmail(template, details),
      text: this.renderPlainText(template, details),
      transactional: false,
      templateKey,
      applicationId: details.applicationUuid,
    });

    return result.sent;
  }
}
