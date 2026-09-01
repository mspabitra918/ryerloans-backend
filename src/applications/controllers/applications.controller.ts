import {
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, Length } from 'class-validator';
import type { Request } from 'express';

import { ApplicationIntakeService } from '../services/application-intake.service';
import { ApplicationStatusService } from '../services/application-status.service';
import { BorrowerActionService } from '../services/borrower-action.service';
import { CreateApplicationDto } from '../dto/create-application.dto';
import {
  CompleteBankVerificationDto,
  ConfirmDepositDto,
  RequestActionLinkDto,
  SignAgreementDto,
} from '../dto/borrower-action.dto';
import { Public } from '../../common/decorators/public.decorator';
import { getClientIp } from '../../common/utils/get-client-ip';
// import { API_PATHS } from 'src/common/constants/api-path.constants';

class PublicStatusQueryDto {
  @IsString()
  @Length(6, 6)
  declare application_id: string;

  @IsEmail()
  declare email: string;
}

/**
 * Borrower-facing endpoints.
 *
 * Split out from the admin surface so the trust boundary is visible in the file
 * layout: nothing in this controller is behind AdminJwtGuard, and nothing in
 * it returns a decrypted field.
 */
@ApiTags('applications')
// @Controller(`${API_PATHS.PUBLIC}/applications`)
@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly intakeService: ApplicationIntakeService,
    private readonly statusService: ApplicationStatusService,
    private readonly borrowerActions: BorrowerActionService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Submit a borrower loan application' })
  @Post()
  async create(
    @Body() dto: CreateApplicationDto,
    @Req() req: Request,
    @Ip() clientIp: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const application = await this.intakeService.create(dto, {
      ipAddress: getClientIp(req) || clientIp,
      // Geolocation headers provided automatically by CDNs like Cloudflare.
      ipCountry: (req.headers['cf-ipcountry'] as string) || null,
      ipRegion: (req.headers['cf-region'] as string) || null,
      userAgent,
      referrer: req.headers.referer ?? null,
    });

    /*
     * Only the reference and state go back. The full record contains the
     * borrower's own SSN and bank details, and echoing it means a browser
     * cache, a proxy log and any analytics tag on the success page all get a
     * copy of them.
     */
    return {
      reference: application.application_id,
      status: application.status,
      submittedAt: application.created_at ?? new Date(),
    };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Public loan application status lookup' })
  @Get('public/status')
  async publicStatus(
    @Query() query: PublicStatusQueryDto,
    @Req() req: Request,
  ) {
    return this.statusService.lookup(
      query.application_id,
      query.email,
      getClientIp(req),
    );
  }

  /**
   * §6.2 tracker: open the step it is showing as outstanding.
   *
   * Throttled harder than the lookup it sits behind — this one mints a live
   * single-use link rather than reading state, and it supersedes any
   * outstanding link for the same purpose, so a script hammering it would keep
   * invalidating the link the borrower is holding.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Borrower requests a live link for an outstanding step (§6.2)',
  })
  @Post('public/action-link')
  async requestActionLink(
    @Body() dto: RequestActionLinkDto,
    @Req() req: Request,
  ) {
    return this.statusService.issueActionLink(
      dto.application_id,
      dto.email,
      dto.purpose,
      getClientIp(req),
    );
  }

  /* ------------------------------------------- §6.1 borrower-driven edges */

  /*
   * The three transitions §6.1 labels with the borrower rather than an admin.
   * Each is authenticated by the one-time link from the borrower's email — no
   * session, no application ID in the body — and each throttles tightly: these
   * are unauthenticated routes that move a loan file forward.
   */

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Borrower completes bank verification (§6.1 Plaid success)',
  })
  @Post('bank-verification/complete')
  async completeBankVerification(
    @Body() dto: CompleteBankVerificationDto,
    @Req() req: Request,
    @Ip() clientIp: string,
  ) {
    return this.borrowerActions.completeBankVerification({
      token: dto.token,
      plaidItemId: dto.plaid_item_id ?? null,
      ipAddress: getClientIp(req) || clientIp,
    });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Borrower e-signs the loan agreement (§6.1)' })
  @Post('agreement/sign')
  async signAgreement(
    @Body() dto: SignAgreementDto,
    @Req() req: Request,
    @Ip() clientIp: string,
  ) {
    return this.borrowerActions.signAgreement({
      token: dto.token,
      fullName: dto.full_name,
      ipAddress: getClientIp(req) || clientIp,
    });
  }

  /*
   * Throttled harder than its siblings: this is the only borrower route where
   * a wrong body can still be a valid guess, so the per-application attempt
   * counter is backed by an IP bucket that a script cannot outrun.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Borrower confirms the micro-deposit amounts (§6.1)',
  })
  @Post('verification-deposit/confirm')
  async confirmDeposit(
    @Body() dto: ConfirmDepositDto,
    @Req() req: Request,
    @Ip() clientIp: string,
  ) {
    return this.borrowerActions.confirmVerificationDeposit({
      token: dto.token,
      amount1Cents: dto.amount_1_cents,
      amount2Cents: dto.amount_2_cents,
      ipAddress: getClientIp(req) || clientIp,
    });
  }
}
