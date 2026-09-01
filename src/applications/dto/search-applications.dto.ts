import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

import { ApplicationStatus } from './application-enums';

/**
 * Comma-separated query params (`?status=approved,funded`) are more pleasant to
 * build in a URL than repeated keys, and both forms are accepted here so a
 * client can use whichever it already has.
 */
const toArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String);

  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

/**
 * Query params arrive as strings, so `?called_in=false` would otherwise be the
 * truthy string "false" and invert the filter.
 */
const toBoolean = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;

  const normalized = String(value).toLowerCase();

  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;

  return undefined;
};

/** §8.2 search box and filter bar. */
export class SearchApplicationsDto {
  /** The single search box. Type is auto-detected server-side. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  declare q?: string;

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsIn(Object.values(ApplicationStatus), { each: true })
  declare status?: ApplicationStatus[];

  /** Single calendar day, in the lender's timezone. */
  @IsOptional()
  @IsISO8601()
  declare date?: string;

  @IsOptional()
  @IsISO8601()
  declare date_from?: string;

  @IsOptional()
  @IsISO8601()
  declare date_to?: string;

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsString({ each: true })
  @Length(2, 2, { each: true })
  declare state?: string[];

  @IsOptional()
  @IsIn(['0-1000', '1000-2500', '2500-5000', '5000-10000', '10000+'])
  declare amount_band?: string;

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsString({ each: true })
  declare loan_purpose?: string[];

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  declare called_in?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  declare bank_verified?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  declare possible_duplicate?: boolean;

  /** An admin user id, or the literal "unassigned". */
  @IsOptional()
  @IsString()
  declare assigned_agent_id?: string;

  /** A utm_source value, or the literal "direct" for untagged traffic. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  declare utm_source?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  declare page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  declare limit?: number;
}

/** §8.3 Notes. */
export class CreateNoteDto {
  @IsString()
  @Length(1, 5000)
  declare body: string;
}

/** §8.3 assign an agent; null clears the assignment. */
export class AssignAgentDto {
  @IsOptional()
  @IsUUID()
  declare admin_user_id?: string | null;
}
