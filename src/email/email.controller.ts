import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { EmailLogService } from '../email-log/email-log.service';
import { SuppressionService } from './suppression.service';
import { SuppressionReason } from './models/email-suppression.model';
import { verifyUnsubscribeToken } from './unsubscribe.util';

/** Normalized event names this endpoint understands. */
type ProviderEvent = 'bounce' | 'complaint' | 'open' | 'delivered';

interface ProviderWebhookPayload {
  event: string;
  email?: string;
  message_id?: string;
  messageId?: string;
  /** Providers distinguish hard from soft bounces; only hard ones suppress. */
  bounce_type?: string;
}

@ApiTags('email')
@Controller('email')
export class EmailController {
  private readonly logger = new Logger(EmailController.name);

  constructor(
    private readonly suppressionService: SuppressionService,
    private readonly emailLogService: EmailLogService,
  ) {}

  /**
   * Landing page for the unsubscribe link in the footer.
   */
  // Renders an HTML page for a human, not a JSON API — nothing to document.
  @ApiExcludeEndpoint()
  @Get('unsubscribe')
  async unsubscribeViaLink(
    @Query('email') email: string,
    @Query('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!email || !verifyUnsubscribeToken(email, token)) {
      res
        .status(400)
        .send(
          this.page(
            'Invalid unsubscribe link',
            'This link is not valid or has expired.',
          ),
        );
      return;
    }

    await this.suppressionService.suppress({
      email,
      reason: SuppressionReason.UNSUBSCRIBE,
      source: 'link',
    });

    res
      .status(200)
      .send(
        this.page(
          'You have been unsubscribed',
          'You will no longer receive reminder emails from Ryer Loans. ' +
            'You will still receive essential notices about any application you have with us.',
        ),
      );
  }

  /**
   * RFC 8058 one-click unsubscribe target. Mail clients POST here directly, so
   * it must succeed without a redirect, a confirmation page, or a session.
   */
  @ApiOperation({
    summary: 'RFC 8058 one-click unsubscribe target',
    description:
      'Called directly by mail clients from the List-Unsubscribe-Post header. ' +
      'Adds the address to the suppression list for non-transactional mail.',
  })
  @Post('unsubscribe')
  @HttpCode(200)
  async unsubscribeOneClick(
    @Query('email') email: string,
    @Query('token') token: string,
  ): Promise<{ unsubscribed: boolean }> {
    if (!email || !verifyUnsubscribeToken(email, token)) {
      throw new BadRequestException('Invalid unsubscribe token');
    }

    await this.suppressionService.suppress({
      email,
      reason: SuppressionReason.UNSUBSCRIBE,
      source: 'one-click',
    });

    return { unsubscribed: true };
  }

  /**
   * Bounce / complaint / open webhook (§7.3).
   *
   * Authenticated with a shared secret in a header, since the ESP has no
   * account to sign in with. Always returns 200 for events it understands but
   * cannot match — providers retry non-2xx responses indefinitely.
   */
  @ApiOperation({
    summary: 'ESP bounce / complaint / open webhook',
    description:
      'Authenticated with the x-webhook-secret header (EMAIL_WEBHOOK_SECRET). ' +
      'Writes back to email_log and adds hard bounces and spam complaints to ' +
      'the suppression list. Accepts a single event or an array.',
  })
  @Post('webhooks/provider')
  @HttpCode(200)
  async handleProviderWebhook(
    @Body() payload: ProviderWebhookPayload | ProviderWebhookPayload[],
    @Headers('x-webhook-secret') secret?: string,
  ): Promise<{ processed: number }> {
    const expected = process.env.EMAIL_WEBHOOK_SECRET;

    if (!expected) {
      throw new UnauthorizedException('EMAIL_WEBHOOK_SECRET is not configured');
    }

    if (secret !== expected) {
      throw new UnauthorizedException('Invalid webhook secret');
    }

    const events = Array.isArray(payload) ? payload : [payload];
    let processed = 0;

    for (const item of events) {
      const normalized = this.normalizeEvent(item.event);
      if (!normalized) continue;

      const messageId = item.message_id ?? item.messageId;

      try {
        if (normalized === 'bounce') {
          // Soft bounces (mailbox full, temporary failure) must not suppress.
          const isHard = (item.bounce_type ?? 'hard').toLowerCase() === 'hard';

          if (messageId) {
            await this.emailLogService.handleWebhookEvent(messageId, 'bounced');
          }

          if (isHard && item.email) {
            await this.suppressionService.suppress({
              email: item.email,
              reason: SuppressionReason.HARD_BOUNCE,
              source: 'webhook',
            });
          }
        } else if (normalized === 'complaint') {
          if (messageId) {
            await this.emailLogService.handleWebhookEvent(
              messageId,
              'complaint',
            );
          }

          if (item.email) {
            await this.suppressionService.suppress({
              email: item.email,
              reason: SuppressionReason.SPAM_COMPLAINT,
              source: 'webhook',
            });
          }
        } else if (normalized === 'open' && messageId) {
          await this.emailLogService.handleWebhookEvent(messageId, 'opened');
        }

        processed++;
      } catch (error) {
        this.logger.error(
          `Failed to process ${normalized} webhook event`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return { processed };
  }

  /**
   * Map the many provider spellings onto our four events. Unknown names return
   * null and are skipped rather than guessed at.
   */
  private normalizeEvent(event: string): ProviderEvent | null {
    switch ((event ?? '').toLowerCase()) {
      case 'bounce':
      case 'bounced':
      case 'hard_bounce':
      case 'hardbounce':
        return 'bounce';
      case 'complaint':
      case 'spam':
      case 'spamreport':
      case 'spam_report':
      case 'abuse':
        return 'complaint';
      case 'open':
      case 'opened':
        return 'open';
      case 'delivered':
      case 'delivery':
        return 'delivered';
      default:
        return null;
    }
  }

  private page(title: string, message: string): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · Ryer Loans</title>
  </head>
  <body style="font-family:Arial,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;color:#374151;">
    <h1 style="color:#14532d;font-size:24px;">${title}</h1>
    <p style="font-size:16px;line-height:1.6;">${message}</p>
  </body>
</html>`;
  }
}
