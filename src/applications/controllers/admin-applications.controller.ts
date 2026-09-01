import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApplicationSearchService } from '../services/application-search.service';
import {
  ApplicationDetailService,
  type ApplicationDetailView,
  type NoteView,
} from '../services/application-detail.service';
import { ApplicationWorkflowService } from '../services/application-workflow.service';
import { AdminUsersService } from '../../admin-users/admin-users.service';
import {
  AssignAgentDto,
  CreateNoteDto,
  SearchApplicationsDto,
} from '../dto/search-applications.dto';
import {
  AdminActionDto,
  ApproveApplicationDto,
  DeclineApplicationDto,
  EditApplicationDto,
  FundApplicationDto,
  RequestDocumentsDto,
  ResendEmailDto,
  SendVerificationDepositDto,
  UpdateStatusDto,
  type ConfirmedActionDto,
} from '../dto/admin-action.dto';
import { RevealDto } from '../../auth/dto/auth.dto';
import { RoleMatrix } from '../../common/roles/role-matrix';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  ECOA_REASON_CODES,
  type AdminActionOptions,
} from '../application.types';
import type { AuthenticatedAdmin } from '../../auth/auth.types';

/**
 * §8.2 search, §8.3 detail, §8.4 actions.
 *
 * Both guards are applied at the class level: an unguarded admin route is the
 * failure this whole module exists to prevent, and applying them per-route
 * means one forgotten decorator publishes borrower PII. Individual routes then
 * narrow further with @Roles.
 */
@ApiTags('admin-applications')
@ApiBearerAuth('admin-jwt')
@Controller('admin/applications')
@UseGuards(AdminJwtGuard, RolesGuard)
export class AdminApplicationsController {
  constructor(
    private readonly searchService: ApplicationSearchService,
    private readonly detailService: ApplicationDetailService,
    private readonly workflowService: ApplicationWorkflowService,
    private readonly adminUsersService: AdminUsersService,
  ) {}

  /** Build the audit context every §8.4 action is recorded against. */
  private actionOptions(
    admin: AuthenticatedAdmin,
    body: AdminActionDto,
  ): AdminActionOptions {
    return {
      admin: { adminUserId: admin.id, ipAddress: admin.ipAddress },
      sendEmail: body.send_email,
      emailOverrideReason: body.email_override_reason,
      emailSubjectOverride: body.email_subject,
      emailBodyOverride: body.email_body,
      note: body.note,
    };
  }

  /**
   * §8.4: "Destructive actions (Decline, Fund) require typing the Application
   * ID to confirm."
   */
  private assertConfirmed(
    applicationId: string,
    body: ConfirmedActionDto,
  ): void {
    if (
      body.confirm_application_id?.trim().toUpperCase() !==
      applicationId.trim().toUpperCase()
    ) {
      throw new BadRequestException(
        'Type the Application ID exactly to confirm this action',
      );
    }
  }

  /* ------------------------------------------------------------- §8.2 search */

  @ApiOperation({ summary: 'Search and filter applications' })
  @Get()
  search(@Query() query: SearchApplicationsDto) {
    return this.searchService.search(query);
  }

  @ApiOperation({ summary: 'Values available in the filter dropdowns' })
  @Get('filters')
  async filters() {
    const [options, agents] = await Promise.all([
      this.searchService.filterOptions(),
      this.adminUsersService.listAssignable(),
    ]);

    return {
      ...options,
      agents,
      document_types: DOCUMENT_TYPES.map((type) => ({
        value: type,
        label: DOCUMENT_TYPE_LABELS[type],
      })),
      ecoa_reason_codes: Object.entries(ECOA_REASON_CODES).map(
        ([code, label]) => ({
          code,
          label,
        }),
      ),
    };
  }

  /* ------------------------------------------------------------- §8.3 detail */

  @ApiOperation({ summary: 'Full application detail page' })
  @Get(':applicationId')
  detail(
    @Param('applicationId') applicationId: string,
  ): Promise<ApplicationDetailView> {
    return this.detailService.detail(applicationId);
  }

  @ApiOperation({
    summary: 'Reveal a masked field — password re-entry, written to audit_log',
  })
  @Roles(...RoleMatrix.reveal)
  @Post(':applicationId/reveal')
  reveal(
    @Param('applicationId') applicationId: string,
    @Body() dto: RevealDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.detailService.reveal({
      applicationId,
      admin,
      password: dto.password,
      field: dto.field,
      reason: dto.reason,
    });
  }

  @ApiOperation({ summary: 'Internal notes (append-only)' })
  @Roles(...RoleMatrix.notes)
  @Post(':applicationId/notes')
  addNote(
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateNoteDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<NoteView> {
    return this.detailService.addNote({ applicationId, admin, body: dto.body });
  }

  @ApiOperation({ summary: 'Assign or clear the owning agent' })
  @Roles(...RoleMatrix.casework)
  @Patch(':applicationId/assign')
  assign(
    @Param('applicationId') applicationId: string,
    @Body() dto: AssignAgentDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.detailService.assignAgent({
      applicationId,
      admin,
      adminUserId: dto.admin_user_id ?? null,
    });
  }

  /* ------------------------------------------------------------ §8.4 actions */

  @ApiOperation({
    summary: 'Mark as Called In — cancels the call reminder drip',
  })
  @Roles(...RoleMatrix.markCalledIn)
  @Patch(':applicationId/called-in')
  markCalledIn(
    @Param('applicationId') applicationId: string,
    @Body() body: AdminActionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.markAsCalledIn(
      applicationId,
      this.actionOptions(admin, body),
    );
  }

  @ApiOperation({
    summary: 'Request Documents — checklist plus an upload link',
  })
  @Roles(...RoleMatrix.requestDocuments)
  @Post(':applicationId/request-documents')
  requestDocuments(
    @Param('applicationId') applicationId: string,
    @Body() body: RequestDocumentsDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.requestDocuments(applicationId, {
      docTypes: body.doc_types,
      note: body.note,
      options: this.actionOptions(admin, body),
    });
  }

  /**
   * §8.4 Edit Application. The response reports whether the borrower was
   * actually emailed rather than whether one was owed — the two differ when
   * the address is suppressed, and an admin who is told "notified" stops
   * chasing.
   */
  @ApiOperation({ summary: 'Edit Application — every change is audited' })
  @Roles(...RoleMatrix.edit)
  @Patch(':applicationId')
  edit(
    @Param('applicationId') applicationId: string,
    @Body() body: EditApplicationDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.editApplication({
      applicationId,
      admin,
      changes: body.changes,
      password: body.password,
      options: this.actionOptions(admin, body),
    });
  }

  @ApiOperation({ summary: 'Send Bank Verification — generates a fresh link' })
  @Roles(...RoleMatrix.casework)
  @Patch(':applicationId/send-bank-verification')
  sendBankVerification(
    @Param('applicationId') applicationId: string,
    @Body() body: AdminActionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.sendBankVerification(
      applicationId,
      this.actionOptions(admin, body),
    );
  }

  @ApiOperation({ summary: 'Send Loan Agreement' })
  @Roles(...RoleMatrix.casework)
  @Patch(':applicationId/send-agreement')
  sendAgreement(
    @Param('applicationId') applicationId: string,
    @Body() body: AdminActionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.sendLoanAgreement(
      applicationId,
      this.actionOptions(admin, body),
    );
  }

  @ApiOperation({ summary: 'Send Verification Deposit' })
  @Roles(...RoleMatrix.casework)
  @Patch(':applicationId/send-verification-deposit')
  sendVerificationDeposit(
    @Param('applicationId') applicationId: string,
    @Body() body: SendVerificationDepositDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.sendVerificationDeposit(
      applicationId,
      {
        amount1Cents: body.amount_1_cents,
        amount2Cents: body.amount_2_cents,
      },
      this.actionOptions(admin, body),
    );
  }

  @ApiOperation({ summary: 'Approve — sets amount, APR, term and payment' })
  @Roles(...RoleMatrix.decide)
  @Patch(':applicationId/approve')
  approve(
    @Param('applicationId') applicationId: string,
    @Body() body: ApproveApplicationDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.approve(
      applicationId,
      { termMonths: body.term_months, apr: body.apr, amount: body.amount },
      this.actionOptions(admin, body),
    );
  }

  @ApiOperation({ summary: 'Decline — requires ECOA reason codes' })
  @Roles(...RoleMatrix.decide)
  @Patch(':applicationId/decline')
  decline(
    @Param('applicationId') applicationId: string,
    @Body() body: DeclineApplicationDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    this.assertConfirmed(applicationId, body);

    return this.workflowService.decline(
      applicationId,
      body.reason_codes,
      this.actionOptions(admin, body),
    );
  }

  @ApiOperation({ summary: 'Fund — records the disbursement' })
  @Roles(...RoleMatrix.fund)
  @Patch(':applicationId/fund')
  fund(
    @Param('applicationId') applicationId: string,
    @Body() body: FundApplicationDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    this.assertConfirmed(applicationId, body);

    return this.workflowService.fund(
      applicationId,
      body.funded_amount,
      this.actionOptions(admin, body),
    );
  }

  /**
   * §8.4, post-funding: ask the borrower for a review.
   *
   * POST rather than PATCH — it creates an invitation and changes nothing on
   * the application, which is already terminal. Sending again supersedes the
   * previous link; sending after the borrower has reviewed is refused.
   */
  @ApiOperation({ summary: 'Send the post-funding review invitation' })
  @Roles(...RoleMatrix.sendReviewInvitation)
  @Post(':applicationId/send-review-invitation')
  sendReviewInvitation(
    @Param('applicationId') applicationId: string,
    @Body() body: AdminActionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.sendReviewInvitation(
      applicationId,
      this.actionOptions(admin, body),
    );
  }

  @ApiOperation({ summary: 'Withdraw — borrower-requested closure' })
  @Roles(...RoleMatrix.casework)
  @Patch(':applicationId/withdraw')
  withdraw(
    @Param('applicationId') applicationId: string,
    @Body() body: AdminActionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.withdraw(
      applicationId,
      this.actionOptions(admin, body),
    );
  }

  @ApiOperation({ summary: 'Change status directly (§6 transitions only)' })
  @Roles(...RoleMatrix.casework)
  @Patch(':applicationId/status')
  updateStatus(
    @Param('applicationId') applicationId: string,
    @Body() body: UpdateStatusDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.updateStatus(
      applicationId,
      body.status,
      this.actionOptions(admin, body),
    );
  }

  /**
   * §8.1 lists "resend emails" among the agent's permitted actions, so this is
   * one of the few write routes the agent role reaches.
   */
  @ApiOperation({ summary: 'Resend a previously logged email' })
  @Roles(...RoleMatrix.resendEmail)
  @Post(':applicationId/resend-email')
  resendEmail(
    @Param('applicationId') applicationId: string,
    @Body() body: ResendEmailDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.workflowService.resendEmail({
      applicationId,
      emailLogId: body.email_log_id,
      options: this.actionOptions(admin, body),
    });
  }
}
