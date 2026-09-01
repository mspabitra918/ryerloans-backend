import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedAdmin } from '../../auth/auth.types';

/**
 * The authenticated admin, as attached by AdminJwtGuard.
 *
 * The guard rejects unauthenticated requests before a handler runs, so this is
 * non-nullable by construction — controllers no longer need to re-check for a
 * missing user the way the old adminOptions() helper did.
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedAdmin => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { admin?: AuthenticatedAdmin }>();

    return request.admin!;
  },
);
