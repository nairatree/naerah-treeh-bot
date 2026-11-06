import { app } from './app.ts';
import { config } from './config/environment.ts';
import { logger } from './utils/logger.ts';
import { followupService } from './modules/followup/followupService.ts';

const server = app.listen(config.PORT, () => {
  logger.info(`=======================================================`);
  logger.info(`🛍️  ${config.STORE_NAME} WhatsApp Assistant Backend`);
  logger.info(`🚀  Server running on http://localhost:${config.PORT}`);
  logger.info(`📱  BotSailor Webhook: http://localhost:${config.PORT}/api/webhook`);
  logger.info(`💻  Admin Control Portal: http://localhost:${config.PORT}/admin`);
  logger.info(`🔑  Default Admin Key: ${config.ADMIN_API_KEY}`);
  logger.info(`=======================================================`);

  // Run automated follow-up processor every 15 minutes
  const FOLLOWUP_INTERVAL_MS = 15 * 60 * 1000;
  setInterval(async () => {
    try {
      const res = await followupService.processDueFollowups();
      if (res.sent > 0) {
        logger.info(`Background Follow-up Job: Dispatched ${res.sent} automated follow-ups.`);
      }
    } catch (err: any) {
      logger.error('Error in background follow-up job:', err.message);
    }
  }, FOLLOWUP_INTERVAL_MS);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server.');
  server.close(() => {
    logger.info('HTTP server closed.');
  });
});
