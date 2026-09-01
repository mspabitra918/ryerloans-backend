/**
 * §11 review system vocabulary.
 *
 * Both lists are closed on purpose. The display-name options are what the
 * borrower consented to see published — a free-text field here would let a
 * borrower publish a name that is not theirs, and would let us publish one
 * they never approved. The rejection reasons are the audit trail for a review
 * that never appeared: "publish or reject only" is only a real constraint if
 * the reject half has to say why.
 */

export const DISPLAY_NAME_PREFERENCES = [
  'full_name',
  'first_initial',
  'first_city',
] as const;

export type DisplayNamePreference = (typeof DISPLAY_NAME_PREFERENCES)[number];

export const DISPLAY_NAME_PREFERENCE_LABELS: Record<
  DisplayNamePreference,
  string
> = {
  full_name: 'Full name',
  first_initial: 'First name and last initial',
  first_city: 'First name and city',
};

/**
 * §11 rejection reasons. `unverifiable` is the catch-all for a review that
 * cannot be tied to what the file says happened — not a licence to reject a
 * verified borrower for being unkind about us.
 */
export const REVIEW_REJECTION_REASONS = {
  profanity: 'Profanity or abusive language',
  pii: 'Contains personal information',
  off_topic: 'Off-topic — not about the loan experience',
  unverifiable: 'Unverifiable claim',
} as const;

export type ReviewRejectionReason = keyof typeof REVIEW_REJECTION_REASONS;

export const REVIEW_REJECTION_REASON_KEYS = Object.keys(
  REVIEW_REJECTION_REASONS,
) as ReviewRejectionReason[];

/**
 * Render the name that will appear on the public site.
 *
 * Derived from the application, never from anything the borrower typed into
 * the form: the whole point of a "verified borrower" badge is that the name
 * beside it comes from the file the loan was funded on.
 */
export function renderDisplayName(
  preference: DisplayNamePreference,
  borrower: { first_name: string; last_name: string; city: string },
): string {
  const first = borrower.first_name.trim();
  const last = borrower.last_name.trim();
  const city = borrower.city.trim();

  switch (preference) {
    case 'full_name':
      return [first, last].filter(Boolean).join(' ');

    case 'first_initial':
      return last ? `${first} ${last[0].toUpperCase()}.` : first;

    case 'first_city':
      return city ? `${first} — ${city}` : first;
  }
}
