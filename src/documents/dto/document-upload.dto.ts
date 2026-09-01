import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { DOCUMENT_TYPES } from '../../applications/application.types';

/**
 * The multipart text field that rides alongside the file.
 *
 * `doc_type` is validated against the closed §8.4 vocabulary rather than a
 * free string: the checklist an admin sent is the whole point of the request,
 * and a borrower posting `doc_type=whatever` would put a file on the file that
 * no checklist item can ever be satisfied by.
 */
export class UploadDocumentDto {
  @ApiProperty({ enum: DOCUMENT_TYPES })
  @IsIn(DOCUMENT_TYPES as unknown as string[], {
    message: `doc_type must be one of: ${DOCUMENT_TYPES.join(', ')}`,
  })
  declare doc_type: string;
}
