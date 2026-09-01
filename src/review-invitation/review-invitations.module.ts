import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';

import { ReviewInvitation } from './models/review-invitation.model';
import { Application } from '../applications/models/application.model';
import { ReviewInvitationService } from './review-invitations.service';
import { ReviewInvitationController } from './review-invitations.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  /*
   * Application is registered for the model only — the invitation page reads
   * the borrower's first name and public reference off it. Importing
   * ApplicationsModule instead would be a cycle: the Fund flow reaches this
   * service, not the other way round.
   */
  imports: [
    SequelizeModule.forFeature([ReviewInvitation, Application]),
    // §11: every publish/reject decision is written to audit_log.
    AuditLogModule,
  ],
  controllers: [ReviewInvitationController],
  providers: [ReviewInvitationService],
  exports: [ReviewInvitationService],
})
export class ReviewInvitationModule {}
