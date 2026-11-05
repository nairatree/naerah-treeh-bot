import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleBotSailorWebhook } from './modules/webhooks/botsailorWebhook.ts';
import { adminRouter } from './modules/admin/adminRoutes.ts';
import { config } from './config/environment.ts';
import { db } from './database/supabaseClient.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

// Standard Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve Admin UI Static Files
const adminPublicPath = path.resolve(__dirname, '../public/admin');
app.use('/admin', express.static(adminPublicPath));

// BotSailor Webhook Ingestion Endpoints (Supports both GET verification & POST events)
app.get('/api/webhook', (req, res) => {
  const challenge = req.query['hub.challenge'] || req.query['challenge'] || 'OK';
  res.status(200).send(challenge);
});
app.post('/api/webhook', handleBotSailorWebhook);
app.post('/webhook', handleBotSailorWebhook);

// Admin Control REST API
app.use('/api/admin', adminRouter);

// Health Check & Diagnostic Endpoint
app.get('/health', async (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    store: config.STORE_NAME,
    database: db.isLive ? 'Supabase Live' : 'In-Memory Development Mock',
    botsailor: config.isLiveBotSailor ? 'Connected' : 'Mock Mode Active',
  });
});

// Root Redirect to Admin or Health
app.get('/', (req, res) => {
  res.redirect('/admin');
});
