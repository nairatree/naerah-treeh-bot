import { Router } from 'express';
import { adminController } from './adminController.ts';
import { adminAuthMiddleware } from './adminAuthMiddleware.ts';

export const adminRouter = Router();

// Apply Auth Protection to all Admin Endpoints
adminRouter.use(adminAuthMiddleware);

adminRouter.get('/stats', adminController.getStats);
adminRouter.get('/products', adminController.getProducts);
adminRouter.post('/products', adminController.createProduct);
adminRouter.delete('/products/:id', adminController.deleteProduct);
adminRouter.post('/products/bulk', adminController.bulkImport);

adminRouter.get('/orders', adminController.getOrders);
adminRouter.patch('/orders/:id/status', adminController.updateOrderStatus);

adminRouter.get('/settings', adminController.getSettings);
adminRouter.post('/settings', adminController.updateSettings);
adminRouter.post('/toggle-bot', adminController.toggleBotStatus);

// LAYER 3 & LAYER 2 Control Endpoints
adminRouter.get('/bot-status', adminController.getBotStatus);
adminRouter.post('/bot-status', adminController.setBotStatus);
adminRouter.get('/human-takeover', adminController.getHumanTakeovers);
adminRouter.post('/human-takeover/clear', adminController.clearHumanTakeover);
adminRouter.delete('/human-takeover/:phone', adminController.clearHumanTakeover);

adminRouter.get('/leads', adminController.getLeads);
adminRouter.post('/leads/followup', adminController.triggerFollowups);

adminRouter.post('/simulate', adminController.simulateMessage);
