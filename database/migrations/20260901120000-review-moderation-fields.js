'use strict';

/**
 * §11 review system: the two columns the pipeline was missing.
 *
 * `display_name_preference` records which of the three §11 options the borrower
 * picked. The rendered string still lands in `display_name`, but the preference
 * is what was actually consented to — regenerating the name from the
 * application later (a corrected surname, say) has to follow the borrower's
 * choice, not a guess at which option produced the stored string.
 *
 * `moderation_reason` is the §11 rejection reason. A rejection with no reason
 * on file is indistinguishable from a review quietly buried for being
 * unflattering, which is the thing the FTC rule is aimed at.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'review_invitations',
        'display_name_preference',
        { type: Sequelize.STRING(20) },
        { transaction },
      );

      await queryInterface.addColumn(
        'review_invitations',
        'moderation_reason',
        { type: Sequelize.STRING(40) },
        { transaction },
      );

      /*
       * One invitation per application, enforced by the database rather than by
       * the findOne() that reads it. A second row would mean two live tokens
       * for one funded loan, and the moderation queue could then hold two
       * reviews from the same borrower.
       */
      await queryInterface.addIndex('review_invitations', ['application_id'], {
        unique: true,
        name: 'review_invitations_application_id_unique',
        transaction,
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex(
        'review_invitations',
        'review_invitations_application_id_unique',
        { transaction },
      );
      await queryInterface.removeColumn(
        'review_invitations',
        'moderation_reason',
        { transaction },
      );
      await queryInterface.removeColumn(
        'review_invitations',
        'display_name_preference',
        { transaction },
      );
    });
  },
};
