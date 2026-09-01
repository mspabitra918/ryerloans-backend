'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      'CREATE EXTENSION IF NOT EXISTS citext;',
    );

    await queryInterface.createTable('email_log', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      application_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'applications', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      template_key: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      to_email: {
        type: 'CITEXT',
        allowNull: false,
      },
      subject: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      scheduled_for: {
        type: Sequelize.DATE,
      },
      sent_at: {
        type: Sequelize.DATE,
      },
      provider_message_id: {
        type: Sequelize.STRING(255),
      },
      opened_at: {
        type: Sequelize.DATE,
      },
      bounced_at: {
        type: Sequelize.DATE,
      },
      complaint_at: {
        type: Sequelize.DATE,
      },
      status: {
        type: Sequelize.STRING(30),
        allowNull: false,
        defaultValue: 'queued',
      },
      cancelled_reason: {
        type: Sequelize.TEXT,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('email_log', ['application_id']);
    await queryInterface.addIndex('email_log', ['status']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('email_log');
  },
};
