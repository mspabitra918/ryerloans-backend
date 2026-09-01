// src/queue/drip/drip.processor.ts

import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/sequelize';
import { Job } from 'bullmq';

import { Application } from '../../applications/models/application.model';
import { EmailSequenceService } from '../../email-sequence/email-sequence.service';
import { SuppressionService } from '../../email/suppression.service';

import { BorrowerActionTokenService } from '../../applications/services/borrower-action-token.service';

import { DRIP_QUEUE_NAME, evaluateCancellation } from './drip.constants';
import { DripEmailService } from './drip-email.service';
import type { DripJobData } from './drip.types';

/**
 * Sends one drip step, if it should still be sent.
 *
 * §7.2: "Each drip step checks conditions at send time, not just at schedule
 * time." Everything this processor decides is therefore re-read from the
 * database as the job runs — the queued payload carries identity only, never
 * borrower state.
 */
@Processor(DRIP_QUEUE_NAME)
export class DripProcessor extends WorkerHost {
  private readonly logger = new Logger(DripProcessor.name);

  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    private readonly dripEmailService: DripEmailService,
    private readonly emailSequenceService: EmailSequenceService,
    private readonly suppressionService: SuppressionService,
    private readonly tokenService: BorrowerActionTokenService,
  ) {
    super();
  }

  async process(job: Job<DripJobData>): Promise<void> {
    const { applicationUuid, sequenceKey, stepNumber, templateKey } = job.data;

    const application = await this.applicationModel.findByPk(applicationUuid);

    if (!application) {
      // The application is gone; there is nothing to cancel and nothing to
      // send. Failing the job would just retry against the same void.
      this.logger.warn(
        `Application ${applicationUuid} not found — dropping ${templateKey}`,
      );
      return;
    }

    /*
     * Re-evaluate every §7.2 cancellation trigger against current state.
     */
    const suppression = await this.suppressionService.isSuppressed(
      application.email,
    );

    const decision = evaluateCancellation(sequenceKey, {
      status: application.status,
      calledIn: Boolean(application.called_in),
      bankVerified: Boolean(application.bank_verified),
      suppressed: suppression.suppressed,
      suppressionReason: suppression.reason ?? null,
    });

    if (decision.shouldCancel) {
      this.logger.log(
        `Cancelling ${templateKey} for ${application.application_id}: ${decision.cancelTrigger}`,
      );

      await this.emailSequenceService.cancelStep(
        applicationUuid,
        sequenceKey,
        stepNumber,
        decision.cancelTrigger ?? 'unknown',
      );

      return;
    }

    /*
     * Mint the verification link at send time, not at schedule time.
     *
     * Only the plaintext token can open the flow and we store only its hash, so
     * a link cannot be recovered to re-use across the six reminders. Each send
     * therefore issues a fresh one and supersedes the previous — which is also
     * the behaviour the copy promises ("this link replaces any we sent
     * earlier"), and it means a reminder never carries a link that predates it.
     */
    const actionUrl =
      sequenceKey === 'bank_verification'
        ? (await this.tokenService.issue(application.id, 'bank_verification'))
            .url
        : undefined;

    try {
      const sent = await this.dripEmailService.sendDripEmail(templateKey, {
        applicationId: application.application_id,
        applicationUuid: application.id,
        firstName: application.first_name,
        email: application.email,
        loanAmount: Number(application.amount_requested),
        actionUrl,
      });

      if (sent) {
        await this.emailSequenceService.markSent(
          applicationUuid,
          sequenceKey,
          stepNumber,
        );

        this.logger.log(
          `Sent ${templateKey} for application ${application.application_id}`,
        );
      } else {
        // Suppressed between the check above and the send itself.
        await this.emailSequenceService.cancelStep(
          applicationUuid,
          sequenceKey,
          stepNumber,
          'suppressed',
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to send ${templateKey} for ${application.application_id}`,
        error instanceof Error ? error.stack : String(error),
      );

      // Mark failed only once BullMQ has exhausted its retries, so a transient
      // SMTP blip does not permanently retire the step.
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await this.emailSequenceService.markFailed(
          applicationUuid,
          sequenceKey,
          stepNumber,
        );
      }

      throw error;
    }
  }
}
