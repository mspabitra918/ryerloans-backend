import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';

import { EmailService } from './email.service';
import { EmailController } from './email.controller';
import { SuppressionService } from './suppression.service';
import { EmailSuppression } from './models/email-suppression.model';
import { EmailLog } from '../email-log/models/email-log.model';
import { EmailLogService } from '../email-log/email-log.service';

@Module({
  imports: [SequelizeModule.forFeature([EmailSuppression, EmailLog])],
  controllers: [EmailController],
  providers: [EmailService, SuppressionService, EmailLogService],
  exports: [EmailService, SuppressionService, EmailLogService],
})
export class EmailModule {}
