// src/email/unsubscribe.util.ts
//
// One-click unsubscribe tokens (RFC 8058, §7.3). The token is an HMAC of the
// normalized address rather than a stored random value, so the List-Unsubscribe
// URL can be generated at send time without an extra table or round trip, and
// cannot be forged to unsubscribe a third party.

import * as crypto from 'crypto';

export function normalizeEmailAddress(email: string): string {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) return normalized;

  let localPart = normalized.slice(0, atIndex).split('+')[0];
  const domain = normalized.slice(atIndex + 1);

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    localPart = localPart.replace(/\./g, '');
  }

  return `${localPart}@${domain}`;
}

function unsubscribeSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || '';

  if (!secret) {
    throw new Error(
      'UNSUBSCRIBE_SECRET (or JWT_SECRET) must be set to sign unsubscribe links',
    );
  }

  return secret;
}

export function generateUnsubscribeToken(email: string): string {
  return crypto
    .createHmac('sha256', unsubscribeSecret())
    .update(normalizeEmailAddress(email))
    .digest('hex');
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const expected = generateUnsubscribeToken(email);
  const provided = Buffer.from(token ?? '', 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  // Bail before timingSafeEqual, which throws on a length mismatch.
  if (provided.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(provided, expectedBuffer);
}

/** Public URL that both the footer link and the RFC 8058 header point at. */
export function buildUnsubscribeUrl(email: string): string {
  const base = (
    process.env.PUBLIC_API_URL ||
    process.env.FRONTEND_URL ||
    'https://www.ryerloans.com'
  ).replace(/\/+$/, '');

  const token = generateUnsubscribeToken(email);

  return `${base}/email/unsubscribe?email=${encodeURIComponent(
    email,
  )}&token=${token}`;
}
