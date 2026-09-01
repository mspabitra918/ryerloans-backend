import type { AdminRole } from '../../admin-users/models/admin-user.model';
import { RoleMatrix } from '../roles/role-matrix';

/**
 * §8.1 grants "reveal sensitive information" to super_admin and to no other
 * role. Re-exported from the role matrix rather than restated, so the
 * service-level check and the route guard cannot drift apart.
 */
export const REVEAL_ALLOWED_ROLES: readonly AdminRole[] = RoleMatrix.reveal;

/** The fields the Reveal control can unmask, as a closed vocabulary. */
export const REVEALABLE_FIELDS = [
  'ssn',
  'dl_number',
  'account_number',
  'routing_number',
] as const;

export type RevealableField = (typeof REVEALABLE_FIELDS)[number];

/**
 * §8.4 edit rule: "SSN and bank account changes additionally require
 * super_admin role and a mandatory reason note".
 */
export const SUPER_ADMIN_ONLY_EDIT_FIELDS = [
  'ssn',
  'account_number',
  'routing_number',
] as const;
