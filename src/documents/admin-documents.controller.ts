import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { DocumentsService } from './documents.service';
import { AdminJwtGuard } from '../common/guards/admin-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';

/**
 * §8.3 document download, for the admin panel.
 *
 * One route. The bytes come back through this API on the admin's own session
 * rather than as a link to the bucket: a signed provider URL is a credential
 * that keeps working after it leaves the browser, and these are files with a
 * borrower's SSN on them.
 */
@ApiTags('admin-documents')
@ApiBearerAuth('admin-jwt')
@Controller('admin/documents')
@UseGuards(AdminJwtGuard, RolesGuard)
export class AdminDocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  /**
   * No @Roles: §8.1 grants "view" to all five roles, and a document on a file
   * an admin can already open is part of that view.
   */
  @ApiOperation({ summary: 'Download one uploaded document' })
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.documentsService.readForDownload(id);

    /*
     * Always an attachment, never inline, and never sniffed. These are files a
     * stranger uploaded: a PDF can carry script, and letting the browser
     * render one on this origin would put it inside the admin's session.
     */
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(file.buffer.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFilename(file.filename)}"; ` +
        `filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );

    res.end(file.buffer);
  }
}

/**
 * The legacy `filename=` parameter is a quoted ASCII string, so anything that
 * would end the quoting early — or is not ASCII at all — is replaced. The
 * `filename*` form alongside it carries the real name for every browser that
 * matters; this one only has to be safe.
 */
function asciiFilename(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  return ascii || 'document';
}
