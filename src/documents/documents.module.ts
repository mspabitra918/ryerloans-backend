import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';

import { Document } from './models/document.model';
import { DocumentRequest } from './models/document-request.model';
import { Application } from '../applications/models/application.model';
import { DocumentsService } from './documents.service';
import { StorageService } from './storage/storage.service';
import { DocumentsController } from './documents.controller';
import { AdminDocumentsController } from './admin-documents.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';

/**
 * §8.3 documents and the §8.4 upload link.
 *
 * AuthModule is not imported: it is @Global, so AdminJwtGuard's JwtService and
 * session store resolve here without it — the same way the applications module
 * guards its admin controllers.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([Document, DocumentRequest, Application]),
    AuditLogModule,
  ],
  controllers: [DocumentsController, AdminDocumentsController],
  providers: [DocumentsService, StorageService],
  exports: [DocumentsService, StorageService],
})
export class DocumentsModule {}
