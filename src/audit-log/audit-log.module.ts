import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';

import { AuditLog } from './models/audit-log.model';
import { AuditLogService } from './audit-log.service';

@Module({
  imports: [SequelizeModule.forFeature([AuditLog])],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
