import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';

import { BorrowerActionToken } from './models/borrower-action-token.model';
import { BorrowerActionTokenService } from './services/borrower-action-token.service';

/**
 * The one-time borrower links, as a leaf module.
 *
 * Split out of ApplicationsModule so the drip queue can mint links without
 * importing it: ApplicationsModule already imports DripModule, and pointing
 * DripModule back at ApplicationsModule would close a cycle. Both now depend on
 * this instead, which keeps a single instance of the service and no forwardRef.
 */
@Module({
  imports: [SequelizeModule.forFeature([BorrowerActionToken])],
  providers: [BorrowerActionTokenService],
  exports: [BorrowerActionTokenService, SequelizeModule],
})
export class BorrowerActionTokenModule {}
