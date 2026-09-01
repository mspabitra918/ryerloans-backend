/**
 * §8.1/§8.3: the admin portal shows masked identifiers by default. Full values
 * are only ever produced by the dedicated "Reveal" endpoint, which requires
 * password re-entry and writes to audit_log.
 *
 * Masking lives here rather than in each service so there is exactly one answer
 * to "what does an agent see", and so the shape of the masked value can be
 * checked in one place.
 */

/** `123-45-6789` -> `•••-••-6789`. */
export function maskSsn(last4?: string | null): string | null {
  if (!last4) return null;
  return `•••-••-${last4}`;
}

/** Bank account / routing numbers -> `••••1234`. */
export function maskAccount(last4?: string | null): string | null {
  if (!last4) return null;
  return `••••${last4}`;
}

export function getLast4(value: string): string {
  return value.slice(-4);
}

/** Driver's licence -> last two characters only; the rest is structure. */
export function maskLicense(value?: string | null): string | null {
  if (!value) return null;
  if (value.length <= 2) return '••';
  return `${'•'.repeat(Math.max(value.length - 2, 2))}${value.slice(-2)}`;
}

/** `john.smith@example.com` -> `jo•••••••@example.com`. */
export function maskEmail(email?: string | null): string | null {
  if (!email) return null;

  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';

  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, Math.min(2, local.length));

  return `${head}${'•'.repeat(Math.max(local.length - head.length, 3))}${domain}`;
}

/** `7472005220` -> `(•••) •••-5220`. */
export function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '•••';

  return `(•••) •••-${digits.slice(-4)}`;
}

/** `(747) 200-5220` -> `(747) 200-5220`, `7472005220` -> `(747) 200-5220`. */
export function formatPhone(phone?: string | null): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return phone;

  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
