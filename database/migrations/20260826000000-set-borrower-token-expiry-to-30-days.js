'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'review_invitations',
        'expires_at',
        {
          type: Sequelize.DATE,
          allowNull: true,
        },
        { transaction },
      );

      await queryInterface.sequelize.query(
        `UPDATE borrower_action_tokens
         SET expires_at = created_at + INTERVAL '30 days'
         WHERE consumed_at IS NULL
           AND revoked_at IS NULL
           AND expires_at > NOW()`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `UPDATE document_requests
         SET expires_at = created_at + INTERVAL '30 days'
         WHERE completed_at IS NULL
           AND expires_at > NOW()`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `UPDATE review_invitations
         SET expires_at = sent_at + INTERVAL '30 days'`,
        { transaction },
      );

      await queryInterface.changeColumn(
        'review_invitations',
        'expires_at',
        {
          type: Sequelize.DATE,
          allowNull: false,
        },
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('review_invitations', 'expires_at');
  },
};
