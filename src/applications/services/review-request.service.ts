import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';

import { Application } from '../models/application.model';
import { ApplicationStatus } from '../dto/application-enums';
import { systemActionOptions } from '../application.types';
import { ApplicationWorkflowService } from './application-workflow.service';
import { ReviewInvitationService } from '../../review-invitation/review-invitations.service';

/** §11: "Day 7 post-funding → review_request email". */
const REVIEW_REQUEST_DELAY_DAYS = 7;

/**
 * How far back the sweep looks. A loan funded months ago is not owed a review
 * request that was never sent at the time — asking then reads as a mailing
 * list, not a follow-up, and the borrower has long since moved on.
 */
const REVIEW_REQUEST_WINDOW_DAYS = 45;

/** Small on purpose: the sweep runs daily and has no backlog to clear. */
const BATCH_LIMIT = 200;

/**
 * The §11 day-7 review request.
 *
 * A cron sweep rather than a drip sequence, and deliberately so. The §7.1 drip
 * grid is anchored on `form_completed_at` and every one of its sequences is
 * cancelled the moment a file reaches a terminal state — funded included. This
 * send is anchored on `funded_at` and exists *because* the file is terminal, so
 * bolting it onto that machinery would mean special-casing the cancellation
 * rules against the one state they are surest about.
 *
 * Idempotency comes from the invitation row, not from a job id: one exists per
 * application, and a borrower who was already invited manually from §8.4 is
 * skipped here.
 */
@Injectable()
export class ReviewRequestService {
  private readonly logger = new Logger(ReviewRequestService.name);

  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    private readonly workflowService: ApplicationWorkflowService,
    private readonly reviewInvitationService: ReviewInvitationService,
  ) {}

  /**
   * Runs once a day. Nothing here is time-critical to the hour, and a missed
   * run costs a borrower a review request that arrives on day 8.
   */
  @Cron(CronExpression.EVERY_DAY_AT_10AM, { name: 'review-request-sweep' })
  async sendDueReviewRequests(): Promise<number> {
    const now = Date.now();
    const dueBefore = new Date(
      now - REVIEW_REQUEST_DELAY_DAYS * 24 * 60 * 60 * 1000,
    );
    const notBefore = new Date(
      now - REVIEW_REQUEST_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    let sent = 0;

    try {
      const funded = await this.applicationModel.findAll({
        where: {
          status: ApplicationStatus.FUNDED,
          funded_at: { [Op.lte]: dueBefore, [Op.gte]: notBefore },
        },
        attributes: ['id', 'application_id'],
        limit: BATCH_LIMIT,
      });

      for (const application of funded) {
        try {
          const existing = await this.reviewInvitationService.findByApplication(
            application.id,
          );

          // Already invited — manually from §8.4, or by an earlier sweep.
          if (existing) continue;

          const result = await this.workflowService.sendReviewInvitation(
            application.id,
            systemActionOptions('Automatic day-7 review request (§11).'),
          );

          if (result.email_sent) sent++;
        } catch (error) {
          this.logger.error(
            `Failed to send the review request for ${application.application_id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      if (sent > 0) {
        this.logger.log(`Sent ${sent} day-7 review request(s)`);
      }
    } catch (error) {
      this.logger.error(
        'Review request sweep failed',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return sent;
  }
}
