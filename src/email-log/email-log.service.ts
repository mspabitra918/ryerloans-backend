import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { EmailLog } from './models/email-log.model';

/**
 * Deliverability roll-up for the admin dashboard (§8.5 "email bounce rate").
 *
 * `sent` counts messages the provider accepted, which is the only defensible
 * denominator for a bounce rate — queued and cancelled mail never reached an
 * inbox and would otherwise deflate the number.
 */
export interface EmailDeliveryStats {
  queued: number;
  sent: number;
  delivered: number;
  bounced: number;
  complaints: number;
  failed: number;
  cancelled: number;
  opened: number;
  bounce_rate_percent: number;
  complaint_rate_percent: number;
  open_rate_percent: number;
}

@Injectable()
export class EmailLogService {
  private readonly logger = new Logger(EmailLogService.name);

  constructor(
    @InjectModel(EmailLog) private readonly emailLogModel: typeof EmailLog,
  ) {}

  async recordQueuedEmail(data: {
    application_id?: string | null;
    template_key: string;
    to_email: string;
    subject: string;
    scheduled_for: Date;
  }): Promise<EmailLog> {
    return this.emailLogModel.create({
      application_id: data.application_id ?? null,
      template_key: data.template_key,
      to_email: data.to_email,
      subject: data.subject,
      scheduled_for: data.scheduled_for,
      status: 'queued',
    });
  }

  /** One log row, for the §8.3 Emails panel and its resend control. */
  async findById(id: string): Promise<EmailLog | null> {
    return this.emailLogModel.findByPk(id);
  }

  async markAsSent(id: string, providerMessageId: string): Promise<EmailLog> {
    const log = await this.emailLogModel.findByPk(id);
    if (!log) throw new NotFoundException('Email log record not found');

    return log.update({
      sent_at: new Date(),
      provider_message_id: providerMessageId,
      status: 'sent',
    });
  }

  /**
   * Bounce / complaint / open webhooks from the ESP (§7.3).
   *
   * Returns null for an unknown message id rather than throwing: providers
   * retry on a non-2xx, and an unrecognised id will never start matching.
   */
  async handleWebhookEvent(
    providerMessageId: string,
    event: 'opened' | 'bounced' | 'complaint',
  ): Promise<EmailLog | null> {
    const log = await this.emailLogModel.findOne({
      where: { provider_message_id: providerMessageId },
    });

    if (!log) {
      this.logger.warn(
        `Webhook ${event} for unknown provider message id ${providerMessageId}`,
      );
      return null;
    }

    const now = new Date();

    if (event === 'opened') {
      return log.update({ opened_at: now });
    }

    if (event === 'bounced') {
      return log.update({ bounced_at: now, status: 'bounced' });
    }

    return log.update({ complaint_at: now });
  }

  /**
   * Aggregate deliverability counters, optionally limited to mail logged on or
   * after `since` (null = lifetime).
   *
   * A bounce is recorded by the ESP webhook as either a `bounced_at` stamp or
   * the terminal `bounced` status, so both are accepted here — a webhook that
   * only set one of the two must not silently drop out of the rate.
   */
  async getDeliveryStats(since?: Date | null): Promise<EmailDeliveryStats> {
    const sequelize = this.emailLogModel.sequelize;

    if (!sequelize) {
      throw new Error('EmailLog model is not bound to a Sequelize instance');
    }

    const [row] = await sequelize.query<{
      queued: number;
      sent: number;
      bounced: number;
      complaints: number;
      failed: number;
      cancelled: number;
      opened: number;
    }>(
      `
        SELECT
          COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
          COUNT(*) FILTER (
            WHERE sent_at IS NOT NULL OR status IN ('sent', 'bounced')
          )::int AS sent,
          COUNT(*) FILTER (
            WHERE bounced_at IS NOT NULL OR status = 'bounced'
          )::int AS bounced,
          COUNT(*) FILTER (WHERE complaint_at IS NOT NULL)::int AS complaints,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened
        FROM email_log
        WHERE (
          CAST(:since AS timestamptz) IS NULL
          OR created_at >= CAST(:since AS timestamptz)
        )
      `,
      {
        replacements: { since: since ?? null },
        type: QueryTypes.SELECT,
      },
    );

    const sent = Number(row?.sent ?? 0);
    const bounced = Number(row?.bounced ?? 0);
    const complaints = Number(row?.complaints ?? 0);
    const opened = Number(row?.opened ?? 0);
    const rate = (part: number) =>
      sent > 0 ? Number(((part / sent) * 100).toFixed(2)) : 0;

    return {
      queued: Number(row?.queued ?? 0),
      sent,
      // Accepted minus hard/soft bounces: what actually landed somewhere.
      delivered: Math.max(sent - bounced, 0),
      bounced,
      complaints,
      failed: Number(row?.failed ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
      opened,
      bounce_rate_percent: rate(bounced),
      complaint_rate_percent: rate(complaints),
      open_rate_percent: rate(opened),
    };
  }
}
