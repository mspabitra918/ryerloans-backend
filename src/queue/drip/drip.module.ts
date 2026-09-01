// src/queue/drip/drip.module.ts

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SequelizeModule } from '@nestjs/sequelize';

import { Application } from '../../applications/models/application.model';
import { BorrowerActionTokenModule } from '../../applications/borrower-action-token.module';
import { EmailModule } from '../../email/email.module';
import { EmailSequenceModule } from '../../email-sequence/email-sequence.module';

import { DRIP_QUEUE_NAME } from './drip.constants';
import { DripService } from './drip.service';
import { DripProcessor } from './drip.processor';
import { DripEmailService } from './drip-email.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: DRIP_QUEUE_NAME }),
    SequelizeModule.forFeature([Application]),
    BorrowerActionTokenModule,
    EmailModule,
    EmailSequenceModule,
  ],

  providers: [DripService, DripProcessor, DripEmailService],

  exports: [DripService, DripEmailService],
})
export class DripModule {}
