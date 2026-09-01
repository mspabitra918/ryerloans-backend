import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';

import { EmailSequence } from './models/email-sequence.model';
import { EmailSequenceService } from './email-sequence.service';

@Module({
  imports: [SequelizeModule.forFeature([EmailSequence])],
  providers: [EmailSequenceService],
  exports: [EmailSequenceService],
})
export class EmailSequenceModule {}
