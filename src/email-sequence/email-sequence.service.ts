import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';

import { EmailSequence, SequenceStatus } from './models/email-sequence.model';

@Injectable()
export class EmailSequenceService {
  constructor(
    @InjectModel(EmailSequence)
    private readonly sequenceModel: typeof EmailSequence,
  ) {}

  /**
   * Record a planned step. Idempotent on (application, sequence, step) so
   * re-running the scheduler updates the existing row instead of duplicating.
   */
  async upsertSequenceStep(data: {
    application_id: string;
    sequence_key: string;
    step_number: number;
    scheduled_for: Date;
  }): Promise<EmailSequence> {
    const [record] = await this.sequenceModel.findOrCreate({
      where: {
        application_id: data.application_id,
        sequence_key: data.sequence_key,
        step_number: data.step_number,
      },
      defaults: { ...data, status: SequenceStatus.SCHEDULED },
    });

    if (record.status === SequenceStatus.SCHEDULED) {
      await record.update({ scheduled_for: data.scheduled_for });
    }

    return record;
  }

  async findStep(
    applicationId: string,
    sequenceKey: string,
    stepNumber: number,
  ): Promise<EmailSequence | null> {
    return this.sequenceModel.findOne({
      where: {
        application_id: applicationId,
        sequence_key: sequenceKey,
        step_number: stepNumber,
      },
    });
  }

  async markSent(
    applicationId: string,
    sequenceKey: string,
    stepNumber: number,
  ): Promise<void> {
    await this.sequenceModel.update(
      { status: SequenceStatus.SENT },
      {
        where: {
          application_id: applicationId,
          sequence_key: sequenceKey,
          step_number: stepNumber,
        },
      },
    );
  }

  async markFailed(
    applicationId: string,
    sequenceKey: string,
    stepNumber: number,
  ): Promise<void> {
    await this.sequenceModel.update(
      { status: SequenceStatus.FAILED },
      {
        where: {
          application_id: applicationId,
          sequence_key: sequenceKey,
          step_number: stepNumber,
        },
      },
    );
  }

  /**
   * Cancel a single step, recording *why* (§7.2: "write the cancellation to
   * email_sequences.cancelled_at + cancel_trigger so you can prove why a
   * borrower stopped receiving mail").
   */
  async cancelStep(
    applicationId: string,
    sequenceKey: string,
    stepNumber: number,
    cancelTrigger: string,
  ): Promise<void> {
    await this.sequenceModel.update(
      {
        status: SequenceStatus.CANCELLED,
        cancelled_at: new Date(),
        cancel_trigger: cancelTrigger,
      },
      {
        where: {
          application_id: applicationId,
          sequence_key: sequenceKey,
          step_number: stepNumber,
          status: SequenceStatus.SCHEDULED,
        },
      },
    );
  }

  /**
   * Cancel every still-scheduled step, optionally limited to specific
   * sequences. Returns the number of steps cancelled.
   */
  async cancelSequences(
    applicationId: string,
    cancelTrigger: string,
    sequenceKeys?: string[],
  ): Promise<number> {
    const where: Record<string, unknown> = {
      application_id: applicationId,
      status: SequenceStatus.SCHEDULED,
    };

    if (sequenceKeys?.length) {
      where.sequence_key = { [Op.in]: sequenceKeys };
    }

    const [updatedCount] = await this.sequenceModel.update(
      {
        status: SequenceStatus.CANCELLED,
        cancelled_at: new Date(),
        cancel_trigger: cancelTrigger,
      },
      { where },
    );

    return updatedCount;
  }

  /** Steps whose send time has arrived — used by the reconciliation sweep. */
  async getDuePendingSteps(limit = 100): Promise<EmailSequence[]> {
    return this.sequenceModel.findAll({
      where: {
        status: SequenceStatus.SCHEDULED,
        scheduled_for: { [Op.lte]: new Date() },
      },
      limit,
      order: [['scheduled_for', 'ASC']],
    });
  }
}
