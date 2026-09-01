// src/queue/drip/drip.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { resolveTimezone } from '../../common/timezone.util';
import { EmailSequenceService } from '../../email-sequence/email-sequence.service';

import { DRIP_QUEUE_NAME, dripJobId } from './drip.constants';
import { buildDripSchedule, type SequenceKey } from './drip.schedule';
import type { DripJobData } from './drip.types';

const ALL_SEQUENCES: SequenceKey[] = ['call_in', 'bank_verification'];

/**
 * What each sequence is called in the server log. The keys are database
 * values; these are what someone reading the console is looking for.
 */
const SEQUENCE_LABEL: Record<SequenceKey, string> = {
  call_in: 'CALL SEQUENCE',
  bank_verification: 'BANK VERIFICATION SEQUENCE',
};

/** 3 call-in steps, 6 bank-verification steps — the larger bounds both. */
const MAX_STEPS_PER_SEQUENCE = 6;

export interface StartSequencesParams {
  applicationUuid: string;
  /** Anchor for the §7.1 grid — applications.form_completed_at. */
  formCompletedAt: Date;
  state?: string | null;
  zip?: string | null;
  /**
   * Transactional sends already known at scheduling time (the confirmation
   * email). A drip step within 90 minutes of one shifts +2h.
   */
  transactionalSends?: Date[];
  sequenceKeys?: SequenceKey[];
}

@Injectable()
export class DripService {
  private readonly logger = new Logger(DripService.name);

  constructor(
    @InjectQueue(DRIP_QUEUE_NAME)
    private readonly queue: Queue<DripJobData>,
    private readonly emailSequenceService: EmailSequenceService,
  ) {}

  /**
   * Plan both sequences per §7.1 and enqueue them.
   *
   * Every planned step is written to email_sequences first, so the schedule is
   * inspectable and auditable even if Redis later loses the job. Queue failures
   * are logged and swallowed: a borrower's application must not fail to submit
   * because the reminder queue is down.
   */
  async startSequences(params: StartSequencesParams): Promise<void> {
    const {
      applicationUuid,
      formCompletedAt,
      state,
      zip,
      transactionalSends = [],
      sequenceKeys = ALL_SEQUENCES,
    } = params;

    const timezone = resolveTimezone(state, zip);

    const plan = buildDripSchedule({
      formCompletedAt,
      timezone,
      transactionalSends,
      sequenceKeys,
    });

    for (const send of plan) {
      try {
        await this.emailSequenceService.upsertSequenceStep({
          application_id: applicationUuid,
          sequence_key: send.sequenceKey,
          step_number: send.stepNumber,
          scheduled_for: send.scheduledFor,
        });
      } catch (error) {
        this.logger.error(
          `Failed to persist ${send.templateKey} for ${applicationUuid}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    const now = Date.now();

    try {
      await Promise.all(
        plan.map((send) =>
          this.queue.add(
            send.templateKey,
            {
              applicationUuid,
              sequenceKey: send.sequenceKey,
              stepNumber: send.stepNumber,
              templateKey: send.templateKey,
            },
            {
              jobId: dripJobId(
                applicationUuid,
                send.sequenceKey,
                send.stepNumber,
              ),
              delay: Math.max(0, send.scheduledFor.getTime() - now),
              attempts: 3,
              backoff: { type: 'exponential', delay: 60_000 },
              removeOnComplete: { age: 7 * 24 * 60 * 60, count: 5000 },
              removeOnFail: { age: 14 * 24 * 60 * 60 },
            },
          ),
        ),
      );

      this.logger.log(
        `Scheduled ${plan.length} drip email(s) for ${applicationUuid} (${timezone}): ` +
          plan
            .map((s) => `${s.templateKey}@${s.scheduledFor.toISOString()}`)
            .join(', '),
      );
    } catch (error) {
      this.logger.error(
        `Failed to enqueue drip sequence for ${applicationUuid}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Cancel queued steps and record why (§7.2).
   *
   * Removing the BullMQ job is best-effort — a job that is already running
   * cannot be removed, which is exactly why the processor re-checks the
   * cancellation rules immediately before it sends.
   */
  async cancelSequences(
    applicationUuid: string,
    cancelTrigger: string,
    sequenceKeys: SequenceKey[] = ALL_SEQUENCES,
  ): Promise<number> {
    if (sequenceKeys.length === 0) return 0;

    let cancelled = 0;

    try {
      /*
       * One update per sequence rather than a single `IN (...)` sweep. It costs
       * an extra statement and buys the only thing the log is read for: which
       * of the two sequences actually stopped, and how many steps each gave up.
       * A combined count cannot answer that — "cancelled 4 steps" is the same
       * line whether the call reminders stopped or not.
       */
      for (const sequenceKey of sequenceKeys) {
        const stopped = await this.emailSequenceService.cancelSequences(
          applicationUuid,
          cancelTrigger,
          [sequenceKey],
        );

        cancelled += stopped;

        // A zero means this sequence was already finished or already cancelled
        // — nothing stopped here, so nothing to announce.
        if (stopped > 0) {
          this.logger.log(
            `${SEQUENCE_LABEL[sequenceKey]} STOPPED for ${applicationUuid} — ` +
              `${stopped} scheduled step(s) cancelled (trigger: ${cancelTrigger})`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to record cancellation for ${applicationUuid}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // Step numbers are small and fixed, so removing by deterministic job id
    // beats scanning the whole delayed set.
    await Promise.all(
      sequenceKeys.flatMap((sequenceKey) =>
        Array.from({ length: MAX_STEPS_PER_SEQUENCE }, (_, index) =>
          this.queue
            .remove(dripJobId(applicationUuid, sequenceKey, index + 1))
            .catch(() => undefined),
        ),
      ),
    );

    return cancelled;
  }
}
