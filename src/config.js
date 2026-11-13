require('dotenv').config();
const csv = value => (value || '').split(',').map(x => x.trim()).filter(Boolean);
module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  staffRoleIds: csv(process.env.STAFF_ROLE_IDS),
  developerRoleIds: csv(process.env.DEVELOPER_ROLE_IDS),
  applicationReviewerRoleIds: csv(process.env.APPLICATION_REVIEWER_ROLE_IDS),
  ticketManagerRoleIds: csv(process.env.TICKET_MANAGER_ROLE_IDS),
  dutyRoleIds: csv(process.env.DUTY_ROLE_IDS),
  dmailRoleIds: csv(process.env.DMAIL_ROLE_IDS),
  invoiceRoleIds: csv(process.env.INVOICE_ROLE_IDS),
  cdnRoleIds: csv(process.env.CDN_ROLE_IDS),
  panelManagerRoleIds: csv(process.env.PANEL_MANAGER_ROLE_IDS),
  auditChannelId: process.env.AUDIT_CHANNEL_ID,
  applicationSubmissionsChannelId: process.env.APPLICATION_SUBMISSIONS_CHANNEL_ID || process.env.APPLICATION_REVIEW_CHANNEL_ID,
  ticketCategoryId: process.env.TICKET_CATEGORY_ID,
  apiHost: process.env.API_HOST || '127.0.0.1',
  apiPort: Number(process.env.API_PORT || 8787),
  apiKey: process.env.API_KEY || '',
  publicCdnBaseUrl: process.env.PUBLIC_CDN_BASE_URL || '',
  databasePath: process.env.DATABASE_PATH || './data/nexus.sqlite',
  uploadDir: process.env.UPLOAD_DIR || './storage',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 20)
};
