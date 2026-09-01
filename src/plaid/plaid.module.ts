import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';

import { Application } from '../applications/models/application.model';
import { ApplicationsModule } from '../applications/applications.module';
import { PlaidController } from './plaid.controller';
import { PlaidService } from './plaid.service';

/**
 * §6.1 `[Plaid success — auto]`.
 *
 * Depends on ApplicationsModule for the one-time link service and the borrower
 * action service, and not the other way round: the state machine has no reason
 * to know which provider verified an account.
 */
@Module({
  imports: [SequelizeModule.forFeature([Application]), ApplicationsModule],
  controllers: [PlaidController],
  providers: [PlaidService],
  exports: [PlaidService],
})
export class PlaidModule {}
