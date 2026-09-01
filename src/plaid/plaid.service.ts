import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type LinkTokenCreateRequest,
} from 'plaid';

import { Application } from '../applications/models/application.model';

/**
 * Plaid Link, behind the §6.1 `[Plaid success — auto]` edge.
 *
 * Only two calls matter for this flow: mint a `link_token` for the borrower's
 * browser, then swap the `public_token` their Link session returns for a
 * long-lived `access_token`. The access token is the credential that can read
 * the borrower's transactions, so it never leaves this service and is never
 * returned to a caller.
 */
@Injectable()
export class PlaidService {
  private readonly logger = new Logger(PlaidService.name);
  private client: PlaidApi | null = null;

  /**
   * Whether Plaid is configured at all.
   *
   * Deployments without credentials — local development, CI — should fail the
   * Plaid endpoints with a clear message rather than crashing at boot and
   * taking the rest of the API down with them.
   */
  get configured(): boolean {
    return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
  }

  /**
   * Built lazily so a missing credential is a 503 on the Plaid routes rather
   * than a boot failure for the whole application.
   */
  private get api(): PlaidApi {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'Bank verification is temporarily unavailable. Please contact our team.',
      );
    }

    if (!this.client) {
      const env = process.env.PLAID_ENV ?? 'sandbox';
      const basePath = PlaidEnvironments[env];

      if (!basePath) {
        throw new InternalServerErrorException(
          `PLAID_ENV="${env}" is not a Plaid environment. ` +
            `Expected one of: ${Object.keys(PlaidEnvironments).join(', ')}.`,
        );
      }

      this.client = new PlaidApi(
        new Configuration({
          basePath,
          baseOptions: {
            headers: {
              'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
              'PLAID-SECRET': process.env.PLAID_SECRET,
            },
          },
        }),
      );
    }

    return this.client;
  }

  /**
   * Mint the short-lived token that opens Plaid Link in the borrower's browser.
   *
   * `client_user_id` is the application's UUID, not the borrower's email or
   * SSN: Plaid stores this value, and there is no reason to hand a third party
   * a durable identifier for the person when an opaque one identifies the file
   * just as well.
   */
  async createLinkToken(application: Application): Promise<{
    linkToken: string;
    expiration: string;
  }> {
    const request: LinkTokenCreateRequest = {
      user: { client_user_id: application.id },
      client_name: 'Ryer Loans',
      products: [Products.Auth],
      country_codes: [CountryCode.Us],
      language: 'en',
      /*
       * Plaid echoes this back on every item webhook for the resulting Item,
       * which is what lets the webhook find the application again without us
       * storing a second lookup table.
       */
      ...(process.env.PLAID_WEBHOOK_URL
        ? { webhook: process.env.PLAID_WEBHOOK_URL }
        : {}),
    };

    try {
      const response = await this.api.linkTokenCreate(request);

      return {
        linkToken: response.data.link_token,
        expiration: response.data.expiration,
      };
    } catch (error) {
      this.logger.error(
        `Plaid linkTokenCreate failed for ${application.application_id}`,
        describe(error),
      );

      throw new ServiceUnavailableException(
        'We could not start bank verification just now. Please try again in a ' +
          'few minutes.',
      );
    }
  }

  /**
   * Swap the borrower's one-time `public_token` for the durable item.
   *
   * Returns only the item id. The access token is what can read the account,
   * and nothing upstream of here needs it — when statement pulls are built,
   * they belong in this service, reading a token this service stored.
   */
  async exchangePublicToken(
    publicToken: string,
    applicationRef: string,
  ): Promise<{ itemId: string; accessToken: string }> {
    try {
      const response = await this.api.itemPublicTokenExchange({
        public_token: publicToken,
      });

      return {
        itemId: response.data.item_id,
        accessToken: response.data.access_token,
      };
    } catch (error) {
      this.logger.error(
        `Plaid itemPublicTokenExchange failed for ${applicationRef}`,
        describe(error),
      );

      throw new ServiceUnavailableException(
        'We could not confirm your bank connection. Please try again, or ' +
          'contact our team.',
      );
    }
  }
}

/**
 * Plaid errors carry the useful part in `response.data`; the Error message
 * alone is usually just "Request failed with status code 400".
 */
function describe(error: unknown): string {
  const data = (error as { response?: { data?: unknown } } | undefined)
    ?.response?.data;

  if (data) return JSON.stringify(data);

  return error instanceof Error ? error.message : String(error);
}
