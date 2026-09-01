import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';

import { StateAvailability } from './models/state-availability.model';
import { StateAvailabilityService } from './state-availability.service';
import { StateAvailabilityController } from './state-availability.controller';

@Module({
  imports: [SequelizeModule.forFeature([StateAvailability])],
  controllers: [StateAvailabilityController],
  providers: [StateAvailabilityService],
  exports: [StateAvailabilityService],
})
export class StateAvailabilityModule {}
