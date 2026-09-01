import { IsString, Length } from 'class-validator';

/** The borrower's one-time link, as it arrives from their email. */
class BorrowerTokenDto {
  @IsString()
  @Length(20, 200)
  declare token: string;
}

export class CreateLinkTokenDto extends BorrowerTokenDto {}

export class ExchangePublicTokenDto extends BorrowerTokenDto {
  /** Returned by Plaid Link's onSuccess callback in the browser. */
  @IsString()
  @Length(10, 200)
  declare public_token: string;
}
