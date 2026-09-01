// src/email/brand.constants.ts
//
// Single source of truth for the facts that appear in borrower-facing mail.
// These were previously duplicated (and contradictory) across email.service.ts
// and drip-email.service.ts.

export const BRAND_NAME = 'Ryer Loans';

export const SUPPORT_PHONE_DISPLAY = '(747) 200-5220';
export const SUPPORT_PHONE_HREF = 'tel:+17472005220';

export const SUPPORT_HOURS = 'Monday – Friday, 6:00 AM – 4:00 PM PT';

export const HOME_URL = 'http://localhost:3000';
// export const HOME_URL = 'https://www.ryerloans.com';
export const HOME_URL_DISPLAY = 'www.ryerloans.com';

/**
 * The bank-verification landing page.
 *
 * Must match the Next route, which is /bank-verification — this said
 * /verify-bank, so every link built from it 404'd.
 */
export const VERIFY_BANK_PATH = '/bank-verification';

export const BRAND_GREEN = '#14532d';
export const BRAND_BLUE = '#1a56db';

export function frontendUrl(): string {
  return (process.env.FRONTEND_URL || HOME_URL).replace(/\/+$/, '');
}

/**
 * Fallback destination for a bank-verification CTA with no minted link.
 *
 * Takes no applicationId any more. Verification is authenticated by the
 * single-use token in the borrower's email, so a six-character reference in the
 * query string authenticated nothing — it only put an identifier into browser
 * history, access logs and any Referer header the page emitted. This lands on
 * the explainer, which tells the borrower where their real link is.
 */
/**
 * The post-funding review form, reached from the invitation email.
 *
 * Must match the Next route, which is /review/[token]. The token is the only
 * thing authenticating the borrower on the submit endpoint, so there is no
 * token-less variant of this URL — a review form nobody can be identified on
 * is a form anyone can stuff.
 */
export const REVIEW_PATH = '/review';

export function reviewUrl(token: string): string {
  return `${frontendUrl()}${REVIEW_PATH}/${encodeURIComponent(token)}`;
}

export function verifyBankUrl(): string {
  return `${frontendUrl()}${VERIFY_BANK_PATH}`;
}

export const PHONE_LINK = `<a href="${SUPPORT_PHONE_HREF}" style="color:${BRAND_BLUE};text-decoration:none;">${SUPPORT_PHONE_DISPLAY}</a>`;
