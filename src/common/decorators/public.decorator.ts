import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'is_public_route';

/** Opt a route out of the admin JWT guard (borrower-facing endpoints). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
