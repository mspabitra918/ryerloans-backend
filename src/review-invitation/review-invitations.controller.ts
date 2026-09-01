import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import {
  ReviewInvitationService,
  type ModerationFilter,
} from './review-invitations.service';
import { SubmitReviewDto } from './dtos/submit-review.dto';
import { ModerateReviewDto } from './dtos/moderate-review.dto';
import {
  DISPLAY_NAME_PREFERENCE_LABELS,
  REVIEW_REJECTION_REASONS,
} from './review.constants';
import { Public } from '../common/decorators/public.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminJwtGuard } from '../common/guards/admin-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { RoleMatrix } from '../common/roles/role-matrix';
import type { AuthenticatedAdmin } from '../auth/auth.types';

const MODERATION_FILTERS: ModerationFilter[] = [
  'pending',
  'published',
  'rejected',
  'all',
];

/**
 * §11 borrower reviews.
 *
 * The moderation routes used to run with `const adminUserId = 1` — a literal
 * that is not even a valid key for the UUID column it was written to — and no
 * guard at all, so anyone on the internet could publish or bury a review.
 *
 * Authenticating them closed that hole but left a smaller one: with only
 * AdminJwtGuard mounted, a @Roles() on a route below would have been read by
 * nobody, and moderation stayed open to every signed-in admin — read_only
 * included, whose §8.1 line is `view` and nothing else. RolesGuard is mounted
 * here so the role restriction on `moderate` is actually enforced, and so the
 * next admin route added to this controller can be restricted at all.
 */
@ApiTags('reviews')
@Controller('reviews')
@UseGuards(AdminJwtGuard, RolesGuard)
export class ReviewInvitationController {
  constructor(private readonly reviewService: ReviewInvitationService) {}

  /* ------------------------------------------------------------- public */

  @Public()
  @ApiOperation({ summary: 'Published borrower reviews' })
  @Get('public')
  async getPublicReviews(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.reviewService.getPublishedReviews(
      Math.min(Number(limit) || 20, 100),
      Math.max(Number(offset) || 0, 0),
    );
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Review invitation details for a token' })
  @Get('invite/:token')
  async getInvitationInfo(@Param('token') token: string) {
    return this.reviewService.getInvitationView(token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Submit a review against an invitation token' })
  @Post('invite/:token/submit')
  @HttpCode(HttpStatus.OK)
  async submitReview(
    @Param('token') token: string,
    @Body() dto: SubmitReviewDto,
  ) {
    const review = await this.reviewService.submitReview(token, dto);

    /*
     * Narrowed on purpose. Returning the model handed the page back its own
     * token, the internal application UUID and the moderation columns — none
     * of which a public response has any business carrying, and the last of
     * which would tell a borrower whether their review had been buried.
     */
    return {
      submitted_at: review.submitted_at,
      rating: review.rating,
      display_name: review.display_name,
      consent_to_publish: review.consent_to_publish,
    };
  }

  /* -------------------------------------------------------- moderation */

  /**
   * §8.1 reads "view" on all five roles, and a queue of submitted reviews is a
   * view — so listing carries no @Roles. Only the decision below is narrowed.
   */
  @ApiBearerAuth('admin-jwt')
  @ApiOperation({ summary: 'Reviews awaiting moderation' })
  @Get('admin/pending')
  async getPendingModeration(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const filter = MODERATION_FILTERS.includes(status as ModerationFilter)
      ? (status as ModerationFilter)
      : 'pending';

    return this.reviewService.listForModeration(
      filter,
      Math.min(Number(limit) || 50, 200),
      Math.max(Number(offset) || 0, 0),
    );
  }

  /** The two closed vocabularies the moderation screen renders from. */
  @ApiBearerAuth('admin-jwt')
  @ApiOperation({ summary: 'Rejection reasons and display-name formats' })
  @Get('admin/options')
  moderationOptions() {
    return {
      rejection_reasons: Object.entries(REVIEW_REJECTION_REASONS).map(
        ([value, label]) => ({ value, label }),
      ),
      display_name_preferences: Object.entries(
        DISPLAY_NAME_PREFERENCE_LABELS,
      ).map(([value, label]) => ({ value, label })),
    };
  }

  @ApiBearerAuth('admin-jwt')
  @ApiOperation({ summary: 'Publish or reject a submitted review' })
  @Roles(...RoleMatrix.moderateReviews)
  @Patch('admin/:id/moderate')
  async moderateReview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateReviewDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const review = await this.reviewService.moderateReview(
      id,
      admin.id,
      dto.approve,
      dto.reason,
      admin.ipAddress,
    );

    /*
     * Spelled out rather than inferred: the model's CreationOptional columns
     * carry a Sequelize brand type that cannot be named from outside the
     * module, which makes an inferred return type here a compile error.
     */
    const decision: {
      id: string;
      is_published: boolean;
      moderated_at: Date | null;
      moderation_reason: string | null;
    } = {
      id: review.id,
      is_published: review.is_published,
      moderated_at: review.moderated_at,
      moderation_reason: review.moderation_reason,
    };

    return decision;
  }
}
