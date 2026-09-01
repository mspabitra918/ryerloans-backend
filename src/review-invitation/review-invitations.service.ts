import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import * as crypto from 'crypto';

import { ReviewInvitation } from './models/review-invitation.model';
import { SubmitReviewDto } from './dtos/submit-review.dto';
import {
  DISPLAY_NAME_PREFERENCES,
  DISPLAY_NAME_PREFERENCE_LABELS,
  renderDisplayName,
  type DisplayNamePreference,
  type ReviewRejectionReason,
} from './review.constants';
import { Application } from '../applications/models/application.model';
import { AuditLogService } from '../audit-log/audit-log.service';

const REVIEW_TOKEN_TTL_DAYS = 30;

/** §11: structured data only switches on once there is a real sample. */
export const SCHEMA_MINIMUM_REVIEWS = 5;

/** What the borrower's review page needs to render itself. */
export interface InvitationView {
  /** The six-character public reference, never the internal UUID. */
  reference: string;
  first_name: string;
  already_submitted: boolean;
  expires_at: Date;
  /** The three §11 display-name options, rendered against this borrower. */
  display_name_options: Array<{
    value: DisplayNamePreference;
    label: string;
    preview: string;
  }>;
}

/** One review as the public site renders it. */
export interface PublicReview {
  id: string;
  rating: number;
  review_text: string;
  display_name: string;
  submitted_at: Date;
}

export interface PublicReviewsResponse {
  reviews: PublicReview[];
  total: number;
  /** Rounded to one decimal, or null while nothing is published. */
  average_rating: number | null;
  /** §11: AggregateRating markup activates at five published reviews. */
  schema_ready: boolean;
}

/** A review in the admin moderation queue, with the file it came from. */
export interface ModerationView {
  id: string;
  application_id: string;
  reference: string;
  rating: number | null;
  review_text: string | null;
  display_name: string | null;
  display_name_preference: string | null;
  consent_to_publish: boolean;
  submitted_at: Date | null;
  sent_at: Date;
  expires_at: Date;
  moderated_at: Date | null;
  moderation_reason: string | null;
  is_published: boolean;
  /** submitted → awaiting a decision; published / rejected once decided. */
  state: 'invited' | 'submitted' | 'published' | 'rejected';
}

export type ModerationFilter = 'pending' | 'published' | 'rejected' | 'all';

@Injectable()
export class ReviewInvitationService {
  constructor(
    @InjectModel(ReviewInvitation)
    private readonly reviewModel: typeof ReviewInvitation,
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    private readonly auditLogService: AuditLogService,
  ) {}

  /* ------------------------------------------------------------ invitations */

  /**
   * Mint the invitation a funded borrower is asked to review on.
   *
   * Idempotent by design rather than one-shot. This used to refuse outright
   * when a row already existed, which made the invitation unsendable a second
   * time — an expired 30-day token, an email that bounced, or an address the
   * borrower has since corrected all left an admin with a button that could
   * only ever return 409. What is genuinely one-shot is the *review*, so that
   * is what is refused here.
   *
   * A re-send supersedes the old token instead of re-mailing it, matching the
   * rule the borrower-action links already follow: the newest email always
   * holds the working link, so a link sent to a stale address stops working.
   */
  async issueForApplication(
    applicationId: string,
  ): Promise<{ invitation: ReviewInvitation; reissued: boolean }> {
    const existing = await this.reviewModel.findOne({
      where: { application_id: applicationId },
    });

    if (existing?.submitted_at) {
      throw new ConflictException(
        'This borrower has already submitted their review.',
      );
    }

    // Secure, unguessable token (64 hex characters).
    const token = crypto.randomBytes(32).toString('hex');
    const sentAt = new Date();
    const expiresAt = new Date(sentAt);
    expiresAt.setDate(expiresAt.getDate() + REVIEW_TOKEN_TTL_DAYS);

    if (existing) {
      const invitation = await existing.update({
        token,
        sent_at: sentAt,
        expires_at: expiresAt,
      });

      return { invitation, reissued: true };
    }

    const invitation = await this.reviewModel.create({
      application_id: applicationId,
      token,
      sent_at: sentAt,
      expires_at: expiresAt,
    });

    return { invitation, reissued: false };
  }

  /** Whether this application has ever been invited. Used by the day-7 sweep. */
  async findByApplication(
    applicationId: string,
  ): Promise<ReviewInvitation | null> {
    return this.reviewModel.findOne({
      where: { application_id: applicationId },
    });
  }

  /**
   * Fetch invitation details by token (used for rendering public review form).
   */
  async getByToken(token: string): Promise<ReviewInvitation> {
    const review = await this.reviewModel.findOne({
      where: { token, expires_at: { [Op.gt]: new Date() } },
    });

    if (!review) {
      throw new NotFoundException('Invalid or expired review token.');
    }

    return review;
  }

  /**
   * What the public review page renders from, for a token that is still live.
   *
   * Deliberately not the raw row. The controller used to hand back
   * `application_id` — the internal UUID, the key every admin route is
   * addressed by — to an unauthenticated caller. The borrower needs their own
   * name, their six-character reference and a preview of each display-name
   * option; nothing else here identifies a record to anyone who does not
   * already hold the token.
   */
  async getInvitationView(token: string): Promise<InvitationView> {
    const invitation = await this.getByToken(token);
    const application = await this.borrowerOf(invitation.application_id);

    return {
      reference: application.application_id,
      first_name: application.first_name,
      already_submitted: Boolean(invitation.submitted_at),
      expires_at: invitation.expires_at,
      display_name_options: DISPLAY_NAME_PREFERENCES.map((value) => ({
        value,
        label: DISPLAY_NAME_PREFERENCE_LABELS[value],
        preview: renderDisplayName(value, application),
      })),
    };
  }

  /* ------------------------------------------------------------- submission */

  /**
   * Submit review feedback using the public token.
   *
   * The published name is rendered here from the application rather than taken
   * from the request: the borrower chooses the *format*, and the file supplies
   * the words. A name typed into the form would make "Verified borrower" mean
   * nothing more than "verified that someone typed a name".
   */
  async submitReview(
    token: string,
    dto: SubmitReviewDto,
  ): Promise<ReviewInvitation> {
    const review = await this.getByToken(token);

    if (review.submitted_at) {
      throw new BadRequestException(
        'This review invitation has already been submitted.',
      );
    }

    const application = await this.borrowerOf(review.application_id);

    return review.update({
      rating: dto.rating,
      review_text: dto.review_text.trim(),
      display_name: renderDisplayName(dto.display_name_preference, application),
      display_name_preference: dto.display_name_preference,
      consent_to_publish: dto.consent_to_publish,
      submitted_at: new Date(),
    });
  }

  /* ------------------------------------------------------------- moderation */

  /**
   * §11 step 3: publish or reject, and log the decision either way.
   *
   * Three rules the UI cannot be trusted to enforce on its own:
   *
   * - A rejection carries a reason. Without one, a review buried for being
   *   unflattering is indistinguishable from one buried for naming a third
   *   party, and the log cannot tell anybody apart afterwards.
   * - Publishing without the borrower's consent checkbox is refused outright.
   * - The text is never touched. There is no parameter for it here, because
   *   the FTC rule covers altered reviews as well as invented ones.
   */
  async moderateReview(
    id: string,
    adminUserId: string,
    approve: boolean,
    reason: ReviewRejectionReason | undefined,
    ipAddress: string,
  ): Promise<ReviewInvitation> {
    const review = await this.reviewModel.findByPk(id);

    if (!review) {
      throw new NotFoundException(`Review record with ID ${id} not found.`);
    }

    if (!review.submitted_at) {
      throw new BadRequestException(
        'Cannot moderate an unsubmitted review invitation.',
      );
    }

    if (approve && !review.consent_to_publish) {
      throw new BadRequestException(
        'This borrower did not consent to public display, so the review ' +
          'cannot be published.',
      );
    }

    if (!approve && !reason) {
      throw new BadRequestException(
        'A rejection reason is required (profanity, pii, off_topic, ' +
          'unverifiable).',
      );
    }

    if (approve && reason) {
      throw new BadRequestException(
        'A rejection reason cannot be recorded against a published review.',
      );
    }

    const updated = await review.update({
      is_published: approve,
      moderated_by: adminUserId,
      moderated_at: new Date(),
      moderation_reason: approve ? null : (reason ?? null),
    });

    await this.auditLogService.log({
      application_id: review.application_id,
      admin_user_id: adminUserId,
      action: 'moderate_review',
      field_changed: 'is_published',
      new_value: { published: approve, reason: reason ?? null },
      ip_address: ipAddress,
    });

    return updated;
  }

  /**
   * The moderation queue, and the history behind it.
   *
   * `pending` is the working list — submitted, not yet decided. The other
   * filters exist so a decision can be looked up afterwards, which is half the
   * point of recording a reason for it.
   */
  async listForModeration(
    filter: ModerationFilter = 'pending',
    limit = 50,
    offset = 0,
  ): Promise<{ rows: ModerationView[]; count: number }> {
    const where = {
      pending: {
        submitted_at: { [Op.ne]: null },
        moderated_at: { [Op.is]: null },
      },
      published: { moderated_at: { [Op.ne]: null }, is_published: true },
      rejected: { moderated_at: { [Op.ne]: null }, is_published: false },
      all: {},
    }[filter];

    const { rows, count } = await this.reviewModel.findAndCountAll({
      where,
      order: [['submitted_at', 'ASC']],
      limit,
      offset,
    });

    const applications = await this.applicationModel.findAll({
      where: { id: { [Op.in]: rows.map((row) => row.application_id) } },
      attributes: ['id', 'application_id'],
    });

    const references = new Map(
      applications.map((application) => [
        application.id,
        application.application_id,
      ]),
    );

    return {
      count,
      rows: rows.map((row) => ({
        id: row.id,
        application_id: row.application_id,
        reference: references.get(row.application_id) ?? '—',
        rating: row.rating ?? null,
        review_text: row.review_text ?? null,
        display_name: row.display_name ?? null,
        display_name_preference: row.display_name_preference ?? null,
        consent_to_publish: row.consent_to_publish,
        submitted_at: row.submitted_at ?? null,
        sent_at: row.sent_at,
        expires_at: row.expires_at,
        moderated_at: row.moderated_at ?? null,
        moderation_reason: row.moderation_reason ?? null,
        is_published: row.is_published,
        state: !row.submitted_at
          ? 'invited'
          : !row.moderated_at
            ? 'submitted'
            : row.is_published
              ? 'published'
              : 'rejected',
      })),
    };
  }

  /* ----------------------------------------------------------------- public */

  /**
   * Published reviews for the public site, plus what §11 needs to decide
   * whether Review / AggregateRating markup goes out with them.
   *
   * The average is computed over every published review, not over the page
   * being rendered — an AggregateRating that changes as the visitor pages
   * through the list is a false claim about the whole.
   */
  async getPublishedReviews(
    limit = 20,
    offset = 0,
  ): Promise<PublicReviewsResponse> {
    const where = { is_published: true, consent_to_publish: true };

    const { rows, count } = await this.reviewModel.findAndCountAll({
      where,
      attributes: [
        'id',
        'rating',
        'review_text',
        'display_name',
        'submitted_at',
      ],
      order: [['submitted_at', 'DESC']],
      limit,
      offset,
    });

    const published = await this.reviewModel.findAll({
      where,
      attributes: ['rating'],
    });

    const ratings = published
      .map((row) => row.rating)
      .filter((rating): rating is number => typeof rating === 'number');

    const average = ratings.length
      ? Math.round(
          (ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) *
            10,
        ) / 10
      : null;

    return {
      total: count,
      average_rating: average,
      schema_ready: count >= SCHEMA_MINIMUM_REVIEWS,
      reviews: rows.map((row) => ({
        id: row.id,
        rating: row.rating as number,
        review_text: row.review_text as string,
        display_name: row.display_name as string,
        submitted_at: row.submitted_at as Date,
      })),
    };
  }

  /* ---------------------------------------------------------------- private */

  private async borrowerOf(applicationId: string): Promise<Application> {
    const application = await this.applicationModel.findByPk(applicationId, {
      attributes: ['id', 'application_id', 'first_name', 'last_name', 'city'],
    });

    if (!application) {
      throw new NotFoundException('Invalid or expired review token.');
    }

    return application;
  }
}
