import { app } from './app.ts';
import { config } from './config/environment.ts';
import { logger } from './utils/logger.ts';

const server = app.listen(config.PORT, () => {
  logger.info(`=======================================================`);
  logger.info(`🛍️  ${config.STORE_NAME} WhatsApp Assistant Backend`);
  logger.info(`🚀  Server running on http://localhost:${config.PORT}`);
  logger.info(`📱  BotSailor Webhook: http://localhost:${config.PORT}/api/webhook`);
  logger.info(`💻  Admin Control Portal: http://localhost:${config.PORT}/admin`);
  logger.info(`🔑  Default Admin Key: ${config.ADMIN_API_KEY}`);
  logger.info(`=======================================================`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server.');
  server.close(() => {
    logger.info('HTTP server closed.');
  });
});
