import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';

import { Application } from './models/application.model';
import { ApplicationNote } from './models/application-note.model';
import { BlockedAttempt } from './models/blocked-attempt.model';
import { AdminUser } from '../admin-users/models/admin-user.model';
import { AuditLog } from '../audit-log/models/audit-log.model';
import { EmailLog } from '../email-log/models/email-log.model';
import { Document } from '../documents/models/document.model';
import { DocumentRequest } from '../documents/models/document-request.model';

import { ApplicationsController } from './controllers/applications.controller';
import { AdminApplicationsController } from './controllers/admin-applications.controller';
import { AdminDashboardController } from './controllers/admin-dashboard.controller';

import { ApplicationIntakeService } from './services/application-intake.service';
import { ApplicationSearchService } from './services/application-search.service';
import { ApplicationDetailService } from './services/application-detail.service';
import { ApplicationWorkflowService } from './services/application-workflow.service';
import { ApplicationDashboardService } from './services/application-dashboard.service';
import { ApplicationStatusService } from './services/application-status.service';
import { ApplicationExpiryService } from './services/application-expiry.service';
import { ReviewRequestService } from './services/review-request.service';
import { BorrowerActionTokenModule } from './borrower-action-token.module';
import { BorrowerActionService } from './services/borrower-action.service';

import { EmailModule } from '../email/email.module';
import { DripModule } from '../queue/drip/drip.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AdminUsersModule } from '../admin-users/admin-users.module';
import { CommonModule } from '../common/common.module';
import { ReviewInvitationModule } from '../review-invitation/review-invitations.module';

/**
 * One module, six services, split along the §8 sections rather than by
 * technical layer — intake, search, detail, workflow, dashboard, expiry.
 *
 * They were a single 2,195-line class. The split is not cosmetic: the public
 * intake path and the admin detail path now cannot reach each other's helpers,
 * which is what allowed a decrypted SSN to end up on a list endpoint.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([
      Application,
      ApplicationNote,
      BlockedAttempt,
      AdminUser,
      AuditLog,
      EmailLog,
      Document,
      DocumentRequest,
    ]),
    BorrowerActionTokenModule,
    CommonModule,
    EmailModule,
    DripModule,
    AuditLogModule,
    AdminUsersModule,
    // §8.4 "Send Review Invitation" mints its token through this service.
    ReviewInvitationModule,
  ],
  controllers: [
    ApplicationsController,
    AdminApplicationsController,
    AdminDashboardController,
  ],
  providers: [
    ApplicationIntakeService,
    ApplicationSearchService,
    ApplicationDetailService,
    ApplicationWorkflowService,
    ApplicationDashboardService,
    ApplicationStatusService,
    ApplicationExpiryService,
    ReviewRequestService,
    BorrowerActionService,
  ],
  exports: [
    ApplicationIntakeService,
    ApplicationDetailService,
    ApplicationWorkflowService,
    BorrowerActionTokenModule,
    BorrowerActionService,
  ],
})
export class ApplicationsModule {}
