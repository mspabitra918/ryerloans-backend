import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';

import { Application } from '../models/application.model';
import { ApplicationStatus } from '../dto/application-enums';
import { EmailService } from '../../email/email.service';
import { DripService } from '../../queue/drip/drip.service';

/** §6: "Any state → ... expired (45 days inactive)". */
const INACTIVITY_DAYS = 45;

/** Applications already at rest are never re-expired. */
const TERMINAL_STATUSES = [
  ApplicationStatus.FUNDED,
  ApplicationStatus.DECLINED,
  ApplicationStatus.WITHDRAWN,
  ApplicationStatus.EXPIRED,
];

@Injectable()
export class ApplicationExpiryService {
  private readonly logger = new Logger(ApplicationExpiryService.name);

  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    private readonly emailService: EmailService,
    private readonly dripService: DripService,
  ) {}

  /**
   * Expire applications untouched for 45 days.
   *
   * Runs hourly rather than daily so the work stays small and a missed run is
   * cheap. Inactivity is measured from updated_at, so any admin or borrower
   * action resets the clock.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'application-expiry-sweep' })
  async expireInactiveApplications(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - INACTIVITY_DAYS);

    let expired = 0;

    try {
      const stale = await this.applicationModel.findAll({
        where: {
          status: { [Op.notIn]: TERMINAL_STATUSES },
          updated_at: { [Op.lt]: cutoff },
        },
        limit: 500,
      });

      for (const application of stale) {
        try {
          application.status = ApplicationStatus.EXPIRED;
          await application.save();

          await this.dripService.cancelSequences(
            application.id,
            'status:expired',
          );

          await this.emailService
            .sendStatusUpdateEmail({
              applicationId: application.application_id,
              firstName: application.first_name,
              email: application.email,
              loanAmount: Number(application.amount_requested),
              status: ApplicationStatus.EXPIRED,
              applicationUuid: application.id,
            })
            .catch((error: unknown) =>
              this.logger.error(
                `Failed to send expiry email for ${application.application_id}`,
                error instanceof Error ? error.stack : String(error),
              ),
            );

          expired++;
        } catch (error) {
          this.logger.error(
            `Failed to expire application ${application.application_id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      if (expired > 0) {
        this.logger.log(`Expired ${expired} inactive application(s)`);
      }
    } catch (error) {
      this.logger.error(
        'Application expiry sweep failed',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return expired;
  }
}
