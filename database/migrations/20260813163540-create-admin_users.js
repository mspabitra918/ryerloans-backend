'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      CREATE TYPE "enum_admin_roles" AS ENUM (
        'super_admin', 'underwriter', 'funding', 'agent', 'read_only'
      );
    `);

    await queryInterface.sequelize.query(
      'CREATE EXTENSION IF NOT EXISTS citext;',
    );

    await queryInterface.createTable('admin_users', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      login_id: {
        type: Sequelize.STRING(50),
        allowNull: false,
        unique: true, // Unique login ID (e.g., GFHR537F)
      },
      email: {
        type: 'CITEXT',
        allowNull: false,
        unique: true,
      },
      password_hash: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      role: {
        type: 'enum_admin_roles',
        allowNull: false,
        defaultValue: 'read_only',
      },
      mfa_secret: {
        type: Sequelize.STRING(128),
      },
      mfa_enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      last_login_at: {
        type: Sequelize.DATE,
      },
      last_login_ip: {
        type: Sequelize.INET,
      },
      failed_attempts: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      locked_until: {
        type: Sequelize.DATE,
      },
      is_active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
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

    // Add index for fast login lookup
    await queryInterface.addIndex('admin_users', ['login_id'], {
      unique: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('admin_users');
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_admin_roles";',
    );
  },
};
