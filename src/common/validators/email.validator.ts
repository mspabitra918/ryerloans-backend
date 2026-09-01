import validator from 'validator';

const COMMON_EMAIL_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'aol.com',
  'icloud.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'msn.com',
  'live.com',
  'me.com',
  'mac.com',
  'bellsouth.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'roadrunner.com',
  'protonmail.com',
  'ymail.com',
];

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'tempmail.com',
  '10minutemail.com',
  'yopmail.com',
  'maildrop.cc',
  'temp-mail.org',
  'throwawaymail.com',
]);

export interface EmailValidationResult {
  valid: boolean;
  normalizedEmail: string;
  reason?: string;
  suggestion?: string;
}

export class EmailValidator {
  static async validate(email: string): Promise<EmailValidationResult> {
    const normalizedEmail = email.trim().toLowerCase();

    /*
     * ============================================================
     * LAYER 1 — RFC-style syntax
     * ============================================================
     */

    if (
      !validator.isEmail(normalizedEmail, {
        allow_utf8_local_part: false,
      })
    ) {
      return {
        valid: false,
        normalizedEmail,
        reason: 'invalid_email_format',
      };
    }

    const parts = normalizedEmail.split('@');

    if (parts.length !== 2) {
      return {
        valid: false,
        normalizedEmail,
        reason: 'invalid_email_format',
      };
    }

    const domain = parts[1];

    /*
     * ============================================================
     * LAYER 2 — TLD
     * ============================================================
     */

    const tld = this.getTld(domain);

    if (!tld || !this.isValidTld(tld)) {
      return {
        valid: false,
        normalizedEmail,
        reason: 'invalid_tld',
      };
    }

    /*
     * ============================================================
     * LAYER 3 — TYPO SUGGESTION
     * ============================================================
     */

    const suggestion = this.getDomainSuggestion(domain);

    if (suggestion) {
      return {
        valid: false,
        normalizedEmail,
        reason: 'possible_typo',
        suggestion: `${parts[0]}@${suggestion}`,
      };
    }

    /*
     * ============================================================
     * LAYER 4 — MX LOOKUP
     * ============================================================
     *
     * Implemented server-side below.
     */

    const hasMx = await this.hasMxRecord(domain);

    if (!hasMx) {
      return {
        valid: false,
        normalizedEmail,
        reason: 'no_mx_record',
      };
    }

    /*
     * ============================================================
     * LAYER 5 — DISPOSABLE DOMAIN
     * ============================================================
     */

    if (DISPOSABLE_DOMAINS.has(domain)) {
      return {
        valid: false,
        normalizedEmail,
        reason: 'disposable_email',
      };
    }

    return {
      valid: true,
      normalizedEmail,
    };
  }

  private static getTld(domain: string): string | null {
    const parts = domain.split('.');

    if (parts.length < 2) {
      return null;
    }

    return parts[parts.length - 1].toLowerCase();
  }

  private static isValidTld(tld: string): boolean {
    /*
     * IMPORTANT:
     * Replace this with the current IANA list.
     *
     * Do not use:
     *
     * /\.w{2,}$/
     *
     * because that accepts fake TLDs.
     */

    return IANA_TLDS.has(tld);
  }

  private static getDomainSuggestion(domain: string): string | null {
    let closestDomain: string | null = null;
    let closestDistance = Infinity;

    for (const validDomain of COMMON_EMAIL_DOMAINS) {
      const distance = this.levenshtein(domain, validDomain);

      if (distance <= 2 && distance < closestDistance) {
        closestDistance = distance;
        closestDomain = validDomain;
      }
    }

    return closestDomain;
  }

  private static levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= a.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= b.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;

        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }

    return matrix[a.length][b.length];
  }

  private static async hasMxRecord(domain: string): Promise<boolean> {
    const dns = await import('dns/promises');

    try {
      const records = await dns.resolveMx(domain);

      return records.length > 0;
    } catch {
      return false;
    }
  }
}

/*
 * ================================================================
 * IANA TLD LIST
 * ================================================================
 *
 * Keep this list synchronized with the official IANA root zone.
 *
 * This is intentionally represented as a Set for fast lookup.
 */

const IANA_TLDS = new Set([
  'com',
  'net',
  'org',
  'edu',
  'gov',
  'mil',
  'int',
  'io',
  'co',
  'us',
  'uk',
  'ca',
  'au',
  'de',
  'fr',
  'in',
  'jp',
  'cn',
  'br',
  'mx',
  'it',
  'es',
  'nl',
  'se',
  'no',
  'dk',
  'fi',
  'ch',
  'at',
  'be',
  'nz',
  'sg',
  'hk',
  'me',
  'tv',
  'ly',
  'ai',
  'dev',
  'app',
  'tech',
  'online',
  'site',
  'xyz',
]);
