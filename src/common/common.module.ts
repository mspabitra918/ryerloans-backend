import { Global, Module } from '@nestjs/common';

import { FieldCryptoService } from './crypto/field-crypto.service';

/**
 * Cross-cutting primitives. Global because field encryption has exactly one
 * key and one implementation — a second instance configured differently is a
 * data-loss bug, not a feature.
 */
@Global()
@Module({
  providers: [FieldCryptoService],
  exports: [FieldCryptoService],
})
export class CommonModule {}
