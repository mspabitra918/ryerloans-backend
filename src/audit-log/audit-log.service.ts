import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import * as crypto from 'crypto';

import { AuditLog } from './models/audit-log.model';

/**
 * The §8.4 admin actions, as a closed vocabulary. Using a union rather than a
 * free string keeps the log queryable — "show me every Decline in March" only
 * works if every decline wrote the same action name.
 */
export type AuditAction =
  | 'mark_called_in'
  | 'request_documents'
  | 'edit_application'
  | 'send_bank_verification'
  | 'send_loan_agreement'
  | 'send_verification_deposit'
  | 'approve'
  | 'decline'
  | 'fund'
  | 'withdraw'
  | 'status_change'
  | 'assign_agent'
  | 'resend_email'
  | 'send_review_invitation'
  | 'moderate_review'
  | 'reveal_pii'
  | 'email_suppressed'
  | 'email_edited'
  /*
   * The borrower's half of "request documents": `request_documents` above is
   * the admin asking, this is one file coming back.
   */
  | 'document_uploaded';

/** Who performed the action, captured once per request. */
export interface AdminContext {
  /** Null when the actor is not an admin — see AuditLog.admin_user_id. */
  adminUserId: string | null;
  /** Defaults to 'admin'; borrower-driven §6.1 edges pass 'borrower'. */
  actorType?: 'admin' | 'borrower' | 'system';
  ipAddress: string;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectModel(AuditLog) private readonly auditLogModel: typeof AuditLog,
  ) {}

  /**
   * Values are hashed, never stored in the clear — see the model docblock.
   * Objects are canonicalised through JSON so the same value always hashes the
   * same way.
   */
  private hashValue(value: unknown): string | null {
    if (value === undefined || value === null) return null;

    // JSON.stringify canonicalises everything except strings (which it would
    // wrap in quotes) and returns undefined for values it cannot represent.
    const serialized =
      typeof value === 'string' ? value : JSON.stringify(value);

    if (serialized === undefined) return null;

    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  async log(params: {
    application_id: string;
    admin_user_id: string | null;
    actor_type?: 'admin' | 'borrower' | 'system';
    action: AuditAction;
    field_changed?: string | null;
    old_value?: unknown;
    new_value?: unknown;
    note?: string | null;
    ip_address: string;
  }): Promise<AuditLog | null> {
    try {
      return await this.auditLogModel.create({
        application_id: params.application_id,
        admin_user_id: params.admin_user_id,
        actor_type: params.actor_type ?? 'admin',
        action: params.action,
        field_changed: params.field_changed ?? null,
        old_value_hash: this.hashValue(params.old_value),
        new_value_hash: this.hashValue(params.new_value),
        note: params.note ?? null,
        ip_address: params.ip_address,
      });
    } catch (error) {
      // An audit write must never take down the action it is recording, but a
      // silent loss is unacceptable — this needs to be alertable.
      this.logger.error(
        `AUDIT WRITE FAILED for ${params.action} on ${params.application_id}`,
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  /**
   * Record a set of field-level changes as individual rows, one per field, so
   * "every field change logged old→new with admin ID + timestamp" (§8.4) holds
   * literally rather than as one blob.
   */
  async logFieldChanges(params: {
    application_id: string;
    admin: AdminContext;
    changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>;
    note?: string | null;
  }): Promise<void> {
    await Promise.all(
      params.changes.map((change) =>
        this.log({
          application_id: params.application_id,
          admin_user_id: params.admin.adminUserId,
          action: 'edit_application',
          field_changed: change.field,
          old_value: change.oldValue,
          new_value: change.newValue,
          note: params.note ?? null,
          ip_address: params.admin.ipAddress,
        }),
      ),
    );
  }

  async findByApplication(applicationId: string): Promise<AuditLog[]> {
    return this.auditLogModel.findAll({
      where: { application_id: applicationId },
      order: [['created_at', 'DESC']],
    });
  }
}
