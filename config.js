/**
 * Backend Configuration File
 * Centralized place for all backend constants and configuration
 * Shared with frontend via environment or API responses
 */

require('dotenv').config();

module.exports = {
  // Server Configuration
  server: {
    port: parseInt(process.env.PORT || '36149', 10),
    host: process.env.HOST || '0.0.0.0',
  },

  // Database Configuration
  database: {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
  },

  // API Endpoints
  api: {
    base: '/api',
    tenants: '/api/tenants',
    packages: '/api/scanned-packages',
    reports: '/api/reports',
  },

  // CORS Configuration
  cors: {
    origin: process.env.CORS_ORIGIN.split(',').map(s => s.trim()),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  },

  // Error Messages
  errors: {
    notFound: 'Not found',
    missingFields: 'Missing required fields',
    failedToFetch: 'Failed to fetch data',
    failedToCreate: 'Failed to create record',
    failedToUpdate: 'Failed to update record',
    failedToDelete: 'Failed to delete record',
    databaseError: 'Database error occurred',
  },

  // Success Messages
  success: {
    created: 'Record created successfully',
    updated: 'Record updated successfully',
    deleted: 'Record deleted successfully',
  },

  // Table Names
  tables: {
    tenants: 'tenants',
    packages: 'scanned_packages',
    reports: 'reports',
  },

  // Validation Rules
  validation: {
    tenant: {
      nameMaxLength: 255,
      addressMaxLength: 255,
      roomMaxLength: 50,
      phoneMaxLength: 50,
    },
    package: {
      recipientNameMaxLength: 255,
      addressMaxLength: 255,
    },
    report: {
      typeMaxLength: 100,
      descriptionMaxLength: 1000,
    },
  },
};
