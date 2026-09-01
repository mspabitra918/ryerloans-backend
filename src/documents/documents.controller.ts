import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import {
  DocumentsService,
  type UploadedFile as MultipartFile,
} from './documents.service';
import { UploadDocumentDto } from './dto/document-upload.dto';
import { UPLOAD_FIELD_NAME, maxUploadBytes } from './document-upload.rules';
import { DOCUMENT_TYPES } from '../applications/application.types';
import { Public } from '../common/decorators/public.decorator';
import { getClientIp } from '../common/utils/get-client-ip';

/**
 * The §8.4 document upload link, from the borrower's side.
 *
 * Everything here is authenticated by the token in the URL and nothing else —
 * there is no session, and the application id is never accepted from the
 * client. The token is the capability: it names one request, on one file, for
 * one checklist, and it expires.
 *
 * The token sits in the path rather than the body, unlike the §6.1 borrower
 * actions. A multipart upload cannot carry its credential in a JSON body, and
 * the alternatives (a custom header, a second round trip) buy nothing for a
 * link that already arrived by email. What does the work is the shape of the
 * token itself: single-purpose, expiring, and stored only as a SHA-256 hash.
 *
 * Two routes, and no more: read the checklist, add a file. Anything the
 * borrower sends is visible to the admin the moment it lands, so there is
 * nothing to submit and nothing to confirm.
 */
@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'The checklist and files behind an upload link' })
  @Get(':token')
  view(@Param('token') token: string) {
    return this.documentsService.getUploadPage(token);
  }

  /**
   * Multer's own limit is set from the same number the service checks against,
   * so an oversized body is cut off as it arrives rather than being buffered
   * into memory in full and rejected afterwards.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Attach one file to an open document request' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [UPLOAD_FIELD_NAME, 'doc_type'],
      properties: {
        [UPLOAD_FIELD_NAME]: { type: 'string', format: 'binary' },
        doc_type: { type: 'string', enum: [...DOCUMENT_TYPES] },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor(UPLOAD_FIELD_NAME, {
      limits: { fileSize: maxUploadBytes(), files: 1 },
    }),
  )
  @Post(':token')
  upload(
    @Param('token') token: string,
    @Body() body: UploadDocumentDto,
    @UploadedFile() file: MultipartFile | undefined,
    @Req() req: Request,
    @Ip() clientIp: string,
  ) {
    if (!file) {
      throw new BadRequestException('Choose a file to upload');
    }

    return this.documentsService.uploadForRequest({
      token,
      docType: body.doc_type,
      file,
      ipAddress: getClientIp(req) || clientIp,
    });
  }
}
