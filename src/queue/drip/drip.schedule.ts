// src/queue/drip/drip.schedule.ts
//
// Implements the brief's §7.1 timing grid. This module is pure: it takes a
// submission time, a borrower timezone and the known transactional sends, and
// returns the exact UTC instants for every drip step. No I/O, no queue, no DB —
// which makes the whole non-clashing ruleset unit-testable.
//
//   Day  | 10:00 AM (call-in)      | 2:30 PM (bank verif) | 6:00 PM (bank verif)
//   -----+-------------------------+----------------------+---------------------
//    0   | confirmation, immediate | --                   | BV #1 (or submit+3h
//        | (transactional)         |                      |  if submitted >4 PM)
//    1   | call_reminder_1         | BV #2                | BV #3
//    2   | call_reminder_2         | BV #4                | BV #5
//    3   | call_reminder_3 (final) | BV #6 (final)        | --
//    4+  | sequence stops          | sequence stops       |
//
// All wall-clock times are in the borrower's timezone (see timezone.util.ts).

import { fromZonedTime, toZonedTime } from 'date-fns-tz';

export const HOUR_MS = 60 * 60 * 1000;

/** Minimum spacing between any two drip sends (§7.1). */
export const MIN_GAP_MS = 2 * HOUR_MS;

/** A transactional send this close to a drip step pushes the drip step (§7.1). */
export const TRANSACTIONAL_CONFLICT_WINDOW_MS = 90 * 60 * 1000;

/** How far a drip step moves when it collides with a transactional send (§7.1). */
export const TRANSACTIONAL_SHIFT_MS = 2 * HOUR_MS;

/** Quiet hours: nothing sends between 21:00 and 08:00 borrower-local (§7.1). */
export const QUIET_HOURS_START = 21;
export const QUIET_HOURS_END = 8;

/** Submitting after this local hour on day 0 delays BV #1 to submit+3h (§7.1). */
const LATE_SUBMISSION_HOUR = 16;
const LATE_SUBMISSION_DELAY_MS = 3 * HOUR_MS;

export type SequenceKey = 'call_in' | 'bank_verification';

export interface PlannedSend {
  sequenceKey: SequenceKey;
  /** 1-based position within its own sequence. */
  stepNumber: number;
  /** §7.3 template key, e.g. `bank_verification_3`. */
  templateKey: string;
  /** Resolved UTC instant to send at. */
  scheduledFor: Date;
  /** Day offset from form_completed_at, per the §7.1 grid. */
  dayIndex: number;
  /** Last step of its sequence — subject to the Sunday weekend rule. */
  isFinal: boolean;
  /** Audit trail of every rule that moved this step off its ideal slot. */
  adjustments: string[];
}

interface IdealSlot {
  sequenceKey: SequenceKey;
  stepNumber: number;
  templateKey: string;
  dayIndex: number;
  /** null = "day 0 immediate", handled specially. */
  hour: number | null;
  minute: number;
  isFinal: boolean;
}

/**
 * The grid, as data. Call-in is 3 emails once daily; bank verification is 6
 * emails twice daily. Both stop after day 3.
 */
const IDEAL_SLOTS: IdealSlot[] = [
  // Call-in sequence — 10:00 AM, days 1..3.
  {
    sequenceKey: 'call_in',
    stepNumber: 1,
    templateKey: 'call_reminder_1',
    dayIndex: 1,
    hour: 10,
    minute: 0,
    isFinal: false,
  },
  {
    sequenceKey: 'call_in',
    stepNumber: 2,
    templateKey: 'call_reminder_2',
    dayIndex: 2,
    hour: 10,
    minute: 0,
    isFinal: false,
  },
  {
    sequenceKey: 'call_in',
    stepNumber: 3,
    templateKey: 'call_reminder_3',
    dayIndex: 3,
    hour: 10,
    minute: 0,
    isFinal: true,
  },

  // Bank verification sequence — 2:30 PM / 6:00 PM, day 0 special-cased.
  {
    sequenceKey: 'bank_verification',
    stepNumber: 1,
    templateKey: 'bank_verification_1',
    dayIndex: 0,
    hour: null,
    minute: 0,
    isFinal: false,
  },
  {
    sequenceKey: 'bank_verification',
    stepNumber: 2,
    templateKey: 'bank_verification_2',
    dayIndex: 1,
    hour: 14,
    minute: 30,
    isFinal: false,
  },
  {
    sequenceKey: 'bank_verification',
    stepNumber: 3,
    templateKey: 'bank_verification_3',
    dayIndex: 1,
    hour: 18,
    minute: 0,
    isFinal: false,
  },
  {
    sequenceKey: 'bank_verification',
    stepNumber: 4,
    templateKey: 'bank_verification_4',
    dayIndex: 2,
    hour: 14,
    minute: 30,
    isFinal: false,
  },
  {
    sequenceKey: 'bank_verification',
    stepNumber: 5,
    templateKey: 'bank_verification_5',
    dayIndex: 2,
    hour: 18,
    minute: 0,
    isFinal: false,
  },
  {
    sequenceKey: 'bank_verification',
    stepNumber: 6,
    templateKey: 'bank_verification_6',
    dayIndex: 3,
    hour: 14,
    minute: 30,
    isFinal: true,
  },
];

/* =========================================================
   Timezone-correct wall-clock helpers

   toZonedTime() returns a Date whose *system-local* fields spell out the wall
   clock in `tz`; fromZonedTime() reads those fields back as `tz` wall time.
   Round-tripping through the pair is what keeps DST transitions honest.
========================================================= */

function localTimeOf(utc: Date, tz: string): Date {
  return toZonedTime(utc, tz);
}

/** The instant `dayOffset` local days after `anchor`, at local `hour:minute`. */
function atLocalTime(
  anchor: Date,
  tz: string,
  dayOffset: number,
  hour: number,
  minute: number,
): Date {
  const local = toZonedTime(anchor, tz);
  local.setDate(local.getDate() + dayOffset);
  local.setHours(hour, minute, 0, 0);
  return fromZonedTime(local, tz);
}

/** Same instant, but moved to local `hour:minute` on the following local day. */
function nextLocalDayAt(utc: Date, tz: string, hour: number): Date {
  const local = toZonedTime(utc, tz);
  local.setDate(local.getDate() + 1);
  local.setHours(hour, 0, 0, 0);
  return fromZonedTime(local, tz);
}

/** Same local day, at local `hour:00`. */
function sameLocalDayAt(utc: Date, tz: string, hour: number): Date {
  const local = toZonedTime(utc, tz);
  local.setHours(hour, 0, 0, 0);
  return fromZonedTime(local, tz);
}

/** Same local wall-clock time, `days` local days later. */
function shiftLocalDays(utc: Date, tz: string, days: number): Date {
  const local = toZonedTime(utc, tz);
  local.setDate(local.getDate() + days);
  return fromZonedTime(local, tz);
}

/* =========================================================
   Individual rules
========================================================= */

function inQuietHours(utc: Date, tz: string): boolean {
  const hour = localTimeOf(utc, tz).getHours();
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

/** Push a send out of the 21:00–08:00 quiet window to the next 08:00 local. */
function applyQuietHours(utc: Date, tz: string): Date {
  const hour = localTimeOf(utc, tz).getHours();

  if (hour < QUIET_HOURS_END) {
    return sameLocalDayAt(utc, tz, QUIET_HOURS_END);
  }
  if (hour >= QUIET_HOURS_START) {
    return nextLocalDayAt(utc, tz, QUIET_HOURS_END);
  }
  return utc;
}

function landsOnSunday(utc: Date, tz: string): boolean {
  return localTimeOf(utc, tz).getDay() === 0;
}

function conflictsWithTransactional(utc: Date, transactional: Date[]): boolean {
  return transactional.some(
    (t) =>
      Math.abs(t.getTime() - utc.getTime()) <= TRANSACTIONAL_CONFLICT_WINDOW_MS,
  );
}

/* =========================================================
   Scheduler
========================================================= */

export interface BuildScheduleOptions {
  /** Anchor for the whole grid — `applications.form_completed_at`. */
  formCompletedAt: Date;
  /** Borrower IANA timezone, from resolveTimezone(state, zip). */
  timezone: string;
  /**
   * Known transactional sends (confirmation, status changes). A drip step
   * landing within 90 minutes of one of these shifts +2h.
   */
  transactionalSends?: Date[];
  /** Restrict the plan to one sequence. Defaults to both. */
  sequenceKeys?: SequenceKey[];
}

/**
 * Resolve the §7.1 grid into concrete UTC send times.
 *
 * Rules are applied to a fixpoint rather than in a single pass: pushing a step
 * out of quiet hours can create a new min-gap violation, which can push another
 * step into quiet hours, and so on. Steps only ever move forward, so this
 * terminates; the iteration cap is a safety net, not the expected exit.
 */
export function buildDripSchedule(
  options: BuildScheduleOptions,
): PlannedSend[] {
  const {
    formCompletedAt,
    timezone,
    transactionalSends = [],
    sequenceKeys,
  } = options;

  const wanted = sequenceKeys
    ? IDEAL_SLOTS.filter((slot) => sequenceKeys.includes(slot.sequenceKey))
    : IDEAL_SLOTS;

  // 1. Ideal slots.
  const sends: PlannedSend[] = wanted.map((slot) => {
    const adjustments: string[] = [];
    let scheduledFor: Date;

    if (slot.hour === null) {
      // Day 0 bank verification #1: 6:00 PM local, unless the borrower
      // submitted after 4 PM, in which case submit + 3h.
      const submittedLocalHour = localTimeOf(
        formCompletedAt,
        timezone,
      ).getHours();

      if (submittedLocalHour >= LATE_SUBMISSION_HOUR) {
        scheduledFor = new Date(
          formCompletedAt.getTime() + LATE_SUBMISSION_DELAY_MS,
        );
        adjustments.push('late-submission-offset');
      } else {
        scheduledFor = atLocalTime(formCompletedAt, timezone, 0, 18, 0);
      }
    } else {
      scheduledFor = atLocalTime(
        formCompletedAt,
        timezone,
        slot.dayIndex,
        slot.hour,
        slot.minute,
      );
    }

    return {
      sequenceKey: slot.sequenceKey,
      stepNumber: slot.stepNumber,
      templateKey: slot.templateKey,
      scheduledFor,
      dayIndex: slot.dayIndex,
      isFinal: slot.isFinal,
      adjustments,
    };
  });

  // 2. Resolve the constraint set to a fixpoint.
  const MAX_ROUNDS = 8;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;

    // 2a. Per-step rules: weekend, quiet hours, transactional collisions.
    for (const send of sends) {
      // Weekend rule: sends continue through the weekend, but a day-3 final
      // that would land on Sunday moves to the next business day.
      if (send.isFinal && landsOnSunday(send.scheduledFor, timezone)) {
        send.scheduledFor = shiftLocalDays(send.scheduledFor, timezone, 1);
        send.adjustments.push('weekend-final-shift');
        changed = true;
      }

      if (inQuietHours(send.scheduledFor, timezone)) {
        send.scheduledFor = applyQuietHours(send.scheduledFor, timezone);
        send.adjustments.push('quiet-hours');
        changed = true;
      }

      if (conflictsWithTransactional(send.scheduledFor, transactionalSends)) {
        send.scheduledFor = new Date(
          send.scheduledFor.getTime() + TRANSACTIONAL_SHIFT_MS,
        );
        send.adjustments.push('transactional-conflict');
        changed = true;
      }
    }

    // 2b. Cross-step rule: no two drip sends within 2 hours of each other.
    sends.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());

    for (let i = 1; i < sends.length; i++) {
      const previous = sends[i - 1];
      const current = sends[i];
      const gap =
        current.scheduledFor.getTime() - previous.scheduledFor.getTime();

      if (gap < MIN_GAP_MS) {
        current.scheduledFor = new Date(
          previous.scheduledFor.getTime() + MIN_GAP_MS,
        );
        current.adjustments.push('min-gap');
        changed = true;
      }
    }

    if (!changed) break;
  }

  sends.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());

  return sends;
}
