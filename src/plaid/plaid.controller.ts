import { Body, Controller, Ip, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InjectModel } from '@nestjs/sequelize';
import type { Request } from 'express';

import { Application } from '../applications/models/application.model';
import { BorrowerActionTokenService } from '../applications/services/borrower-action-token.service';
import { BorrowerActionService } from '../applications/services/borrower-action.service';
import { Public } from '../common/decorators/public.decorator';
import { getClientIp } from '../common/utils/get-client-ip';
import { PlaidService } from './plaid.service';
import { CreateLinkTokenDto, ExchangePublicTokenDto } from './dto/plaid.dto';

/**
 * The browser half of §6.1's `[Plaid success — auto]`.
 *
 * Both routes are borrower-facing and authenticated by the one-time link from
 * their email — there is no session here. The link is only *spent* by the
 * exchange, since the borrower needs it twice: once to open Plaid Link and
 * again to record what came back.
 */
@ApiTags('plaid')
@Controller('plaid')
export class PlaidController {
  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    private readonly plaidService: PlaidService,
    private readonly tokenService: BorrowerActionTokenService,
    private readonly borrowerActions: BorrowerActionService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a Plaid Link token for the borrower' })
  @Post('link-token')
  async createLinkToken(@Body() dto: CreateLinkTokenDto) {
    // verify, not consume: the exchange below is the call that spends the link.
    const { applicationId } = await this.tokenService.verify(
      dto.token,
      'bank_verification',
    );

    const application = await this.applicationModel.findByPk(applicationId);

    if (!application) {
      throw new Error(
        `Token resolved to a missing application: ${applicationId}`,
      );
    }

    const { linkToken, expiration } =
      await this.plaidService.createLinkToken(application);

    // Only the link token goes back. It is scoped to this one Link session and
    // is useless without the borrower completing the flow in their browser.
    return { link_token: linkToken, expiration };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Exchange the Plaid public token and advance the application',
  })
  @Post('exchange')
  async exchange(
    @Body() dto: ExchangePublicTokenDto,
    @Req() req: Request,
    @Ip() clientIp: string,
  ) {
    const ipAddress = getClientIp(req) || clientIp;

    /*
     * Exchange first, advance second. Recording a verification we could not
     * actually complete would tell the borrower — and the file — that their
     * account is verified when Plaid never confirmed it.
     */
    const { applicationId } = await this.tokenService.verify(
      dto.token,
      'bank_verification',
    );

    const { itemId } = await this.plaidService.exchangePublicToken(
      dto.public_token,
      applicationId,
    );

    return this.borrowerActions.completeBankVerification({
      token: dto.token,
      plaidItemId: itemId,
      ipAddress,
    });
  }
}
