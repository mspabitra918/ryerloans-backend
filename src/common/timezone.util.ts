// src/common/timezone.util.ts
//
// Borrower timezone resolution for the email scheduler (brief §7.1: "quiet
// hours ... in the borrower's timezone, derived from state/ZIP").
//
// Resolution order: ZIP prefix override -> state default -> America/Los_Angeles
// (the lender's own timezone, used as the last-resort fallback so a borrower
// with an unparseable address still gets sane send times).

export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/**
 * Primary IANA timezone per state. States that straddle a timezone boundary
 * are listed with their *majority* zone here and corrected by ZIP below.
 */
const STATE_TIMEZONES: Record<string, string> = {
  AK: 'America/Anchorage',
  AL: 'America/Chicago',
  AR: 'America/Chicago',
  AZ: 'America/Phoenix', // no DST (except the Navajo Nation, see ZIP overrides)
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DC: 'America/New_York',
  DE: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  IA: 'America/Chicago',
  ID: 'America/Boise',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  MA: 'America/New_York',
  MD: 'America/New_York',
  ME: 'America/New_York',
  MI: 'America/Detroit',
  MN: 'America/Chicago',
  MO: 'America/Chicago',
  MS: 'America/Chicago',
  MT: 'America/Denver',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  NE: 'America/Chicago',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NV: 'America/Los_Angeles',
  NY: 'America/New_York',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VA: 'America/New_York',
  VT: 'America/New_York',
  WA: 'America/Los_Angeles',
  WI: 'America/Chicago',
  WV: 'America/New_York',
  WY: 'America/Denver',
};

/**
 * ZIP prefix -> timezone, for the parts of split states that do not follow the
 * state default. Longest matching prefix wins, so a 5-digit entry beats a
 * 3-digit one.
 */
const ZIP_PREFIX_TIMEZONES: Record<string, string> = {
  // Florida panhandle west of the Apalachicola River -> Central
  '324': 'America/Chicago',
  '325': 'America/Chicago',
  '3234': 'America/Chicago',

  // West Texas -> Mountain
  '798': 'America/Denver',
  '799': 'America/Denver',
  '885': 'America/Denver',

  // Western Kansas / Nebraska / the Dakotas -> Mountain
  '677': 'America/Denver',
  '679': 'America/Denver',
  '691': 'America/Denver',
  '693': 'America/Denver',
  '576': 'America/Denver',
  '577': 'America/Denver',
  '586': 'America/Denver',
  '588': 'America/Denver',

  // Michigan's western Upper Peninsula -> Central
  '498': 'America/Menominee',
  '499': 'America/Menominee',

  // Northwest + southwest Indiana -> Central
  '463': 'America/Indiana/Knox',
  '464': 'America/Indiana/Knox',
  '473': 'America/Indiana/Vincennes',
  '476': 'America/Indiana/Vincennes',
  '477': 'America/Indiana/Vincennes',

  // Western Kentucky -> Central
  '420': 'America/Chicago',
  '421': 'America/Chicago',
  '422': 'America/Chicago',
  '423': 'America/Chicago',
  '424': 'America/Chicago',
  '425': 'America/Chicago',
  '426': 'America/Chicago',
  '427': 'America/Chicago',

  // Eastern Tennessee -> Eastern
  '373': 'America/New_York',
  '374': 'America/New_York',
  '377': 'America/New_York',
  '378': 'America/New_York',
  '379': 'America/New_York',

  // Northern Idaho -> Pacific
  '838': 'America/Los_Angeles',

  // Malheur County, Oregon -> Mountain
  '979': 'America/Boise',

  // Navajo Nation in northeastern Arizona observes DST
  '865': 'America/Denver',
  '864': 'America/Denver',

  // Western Florida keys/panhandle border town of Pensacola is covered by 325
};

/**
 * Resolve the borrower's IANA timezone from their state and ZIP.
 *
 * Never throws: an unknown state or malformed ZIP falls back to
 * {@link DEFAULT_TIMEZONE} so scheduling can always proceed.
 */
export function resolveTimezone(
  state?: string | null,
  zip?: string | null,
): string {
  const digits = (zip ?? '').replace(/\D/g, '');

  // Longest ZIP prefix wins (5 digits down to 3).
  for (let length = Math.min(5, digits.length); length >= 3; length--) {
    const match = ZIP_PREFIX_TIMEZONES[digits.slice(0, length)];
    if (match) return match;
  }

  const stateCode = (state ?? '').trim().toUpperCase();
  return STATE_TIMEZONES[stateCode] ?? DEFAULT_TIMEZONE;
}
