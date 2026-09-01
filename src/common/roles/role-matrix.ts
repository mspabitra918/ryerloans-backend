import { AdminRole } from '../../admin-users/models/admin-user.model';

/**
 * §8.1, verbatim:
 *
 *   super_admin — view, edit, request documents, approve, decline, fund,
 *                 final terms, mark called-in, resend emails, manage admin
 *                 users, reveal sensitive information
 *   underwriter — view, edit, request documents, approve, decline
 *   funding     — view, fund, final terms
 *   agent       — view, mark called-in, resend emails
 *   read_only   — view
 *
 * Read as a closed list: a capability a role is not granted is denied, even
 * where granting it would seem harmless. Mark called-in and resend emails are
 * the agent's job, not a floor every operator stands on, and reveal is
 * super_admin's alone.
 *
 * One table, because the alternative is what it replaced: four ad-hoc arrays
 * in one controller, a fifth list in pii.constants, and a frontend `can.*`
 * that agreed with none of them. Capabilities are named with the spec's own
 * words so a reader can check the code against the sentence without
 * translating first.
 *
 * The guard is the enforcement point; this is only the vocabulary.
 */

/** Every role that may write anything at all — read_only is the viewer. */
const OPERATORS = [
  AdminRole.SUPER_ADMIN,
  AdminRole.UNDERWRITER,
  AdminRole.FUNDING,
  AdminRole.AGENT,
] as const;

export const RoleMatrix = {
  /**
   * "view" — listed for all five roles, so search, filters, detail and the
   * dashboard carry no @Roles at all. read_only ends here.
   */
  view: [...OPERATORS, AdminRole.READ_ONLY],

  /**
   * "underwriter (… edit …)". Funding is deliberately absent: its line reads
   * "view, fund, final terms", which stops well short of amending a file.
   */
  edit: [AdminRole.SUPER_ADMIN, AdminRole.UNDERWRITER],

  /** "underwriter (… request docs …)". */
  requestDocuments: [AdminRole.SUPER_ADMIN, AdminRole.UNDERWRITER],

  /**
   * Moving a file between intake and a decision — bank verification, the
   * agreement, the micro-deposit, assignment, withdrawal, direct status
   * changes.
   *
   * §8.1 names none of these individually. They are the connective tissue of
   * "edit … approve/decline", so they follow the underwriter, not the funding
   * officer, whose file only opens once the decision is already made.
   */
  casework: [AdminRole.SUPER_ADMIN, AdminRole.UNDERWRITER],

  /** "underwriter (… approve/decline)". */
  decide: [AdminRole.SUPER_ADMIN, AdminRole.UNDERWRITER],

  /**
   * "funding — view, fund, final terms". Both halves are the one Fund action:
   * §8.4 gives funding no separate button, and the disbursement amount it
   * records IS the final term. If final terms later become their own
   * endpoint, they split off here rather than widening `decide`.
   */
  fund: [AdminRole.SUPER_ADMIN, AdminRole.FUNDING],

  /**
   * "agent — view, mark called-in, resend emails".
   *
   * These are the agent's own two write actions, not a shared operational
   * floor: §8.1 grants them to the agent and to super_admin, and to nobody
   * else. The underwriter's line stops at approve/decline and funding's at
   * final terms, so neither gets to log a call they did not make.
   */
  markCalledIn: [AdminRole.SUPER_ADMIN, AdminRole.AGENT],
  resendEmail: [AdminRole.SUPER_ADMIN, AdminRole.AGENT],

  /**
   * Internal notes are not in the §8.1 list at all. They stay with every role
   * that may write something, because a note is the reasoning attached to an
   * action rather than an action in its own right — and the called-in, edit
   * and decision payloads each already carry one.
   */
  notes: [...OPERATORS],

  /**
   * "super_admin — … reveal sensitive information", and no other line
   * mentions it.
   *
   * Underwriter and funding used to hold this on the reasoning that
   * underwriting reads an SSN and disbursing reads an account number. §8.1
   * does not grant it to either, and a decrypted SSN is not a privilege to
   * infer. Both roles still work off the masked values and the last four.
   */
  reveal: [AdminRole.SUPER_ADMIN],

  /**
   * Asking a funded borrower for a review.
   *
   * Not in §8.1 either, and read the same closed way — but it is not the same
   * capability as moderating what comes back. Sending is an operational touch
   * on a file that has just been funded, so it follows the officer who funded
   * it; deciding what appears on the public site stays below, at super_admin.
   * The button is only ever offered from `funded`, which the service re-checks.
   */
  sendReviewInvitation: [AdminRole.SUPER_ADMIN, AdminRole.FUNDING],

  /**
   * Publishing or burying a borrower review on the public site.
   *
   * §8.1 does not name it, so it is read the way the list is read elsewhere:
   * not granted is denied. It is not casework on an applicant's file and not
   * user management — it is marketing copy going out under the lender's name,
   * which puts it with the state lending rules, at super_admin.
   *
   * The listing side stays open to every authenticated admin, because "view"
   * is on all five lines and a queue of submitted reviews is a view.
   */
  moderateReviews: [AdminRole.SUPER_ADMIN],

  /** "super_admin (all + user management)". */
  manageUsers: [AdminRole.SUPER_ADMIN],
} as const satisfies Record<string, readonly AdminRole[]>;

export type Capability = keyof typeof RoleMatrix;

export function roleCan(role: AdminRole, capability: Capability): boolean {
  return (RoleMatrix[capability] as readonly AdminRole[]).includes(role);
}
