import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';

import {
  EmailSuppression,
  SuppressionReason,
} from './models/email-suppression.model';
import { normalizeEmailAddress } from './unsubscribe.util';

export interface SuppressionCheck {
  suppressed: boolean;
  reason?: SuppressionReason;
}

/**
 * The pre-send suppression gate required by §7.3.
 *
 * Hard bounces and spam complaints suppress every kind of mail; an unsubscribe
 * suppresses drip/marketing mail but still allows transactional notices the
 * borrower needs (agreement sent, declined, funded).
 */
@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(
    @InjectModel(EmailSuppression)
    private readonly suppressionModel: typeof EmailSuppression,
  ) {}

  async suppress(params: {
    email: string;
    reason: SuppressionReason;
    source?: string;
  }): Promise<EmailSuppression> {
    const { email, reason, source } = params;
    const emailNormalized = normalizeEmailAddress(email);

    const suppressesTransactional =
      reason === SuppressionReason.HARD_BOUNCE ||
      reason === SuppressionReason.SPAM_COMPLAINT;

    const [record, created] = await this.suppressionModel.findOrCreate({
      where: { email_normalized: emailNormalized },
      defaults: {
        email_normalized: emailNormalized,
        email,
        reason,
        suppresses_transactional: suppressesTransactional,
        source: source ?? null,
        suppressed_at: new Date(),
      },
    });

    // An address already suppressed for a softer reason gets upgraded — an
    // unsubscribe followed by a hard bounce must end up blocking everything.
    if (
      !created &&
      suppressesTransactional &&
      !record.suppresses_transactional
    ) {
      await record.update({
        reason,
        suppresses_transactional: true,
        source: source ?? record.source,
      });
    }

    this.logger.log(`Suppressed ${emailNormalized} (${reason})`);

    return record;
  }

  /**
   * @param transactional whether the mail about to be sent is transactional;
   *   unsubscribes do not block transactional notices.
   */
  async check(
    email: string,
    transactional: boolean,
  ): Promise<SuppressionCheck> {
    const record = await this.suppressionModel.findOne({
      where: { email_normalized: normalizeEmailAddress(email) },
    });

    if (!record) return { suppressed: false };

    if (transactional && !record.suppresses_transactional) {
      return { suppressed: false };
    }

    return { suppressed: true, reason: record.reason };
  }

  async isSuppressed(email: string): Promise<SuppressionCheck> {
    return this.check(email, false);
  }

  async remove(email: string): Promise<number> {
    return this.suppressionModel.destroy({
      where: { email_normalized: normalizeEmailAddress(email) },
    });
  }
}
