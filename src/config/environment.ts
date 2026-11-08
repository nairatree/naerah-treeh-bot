import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('4001').transform((val) => parseInt(val, 10)),
  
  // Admin Dashboard Security
  ADMIN_API_KEY: z.string().default('nairatee_admin_secret_2026'),
  
  // BotSailor WhatsApp Cloud API Gateway
  BOTSAILOR_BASE_URL: z.string().default('https://botsailor.com/api/v1'),
  BOTSAILOR_API_KEY: z.string().default('mock-botsailor-api-key'),
  BOTSAILOR_WHATSAPP_BOT_ID: z.string().default('mock-bot-id'),
  
  // Supabase PostgreSQL Database
  SUPABASE_URL: z.string().default('https://mock-project.supabase.co'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default('mock-supabase-key'),
  SUPABASE_ANON_KEY: z.string().default('mock-supabase-anon-key'),
  
  // Store Branding & Financial Details
  STORE_NAME: z.string().default('NairaTree Stores'),
  BANK_NAME: z.string().default('Access Bank'),
  BANK_ACCOUNT_NUMBER: z.string().default('0123456789'),
  BANK_ACCOUNT_NAME: z.string().default('NairaTree Stores Enterprise'),
  SUPPORT_PHONE_NUMBER: z.string().default('2348000000000'),
  
  // Authorized Admin Phones (comma-separated, can use /add command on WhatsApp)
  ADMIN_PHONES: z.string().default('2348000000000'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid environment variables configuration:', parsedEnv.error.format());
  throw new Error('Environment configuration error');
}

const rawSupabaseUrl = parsedEnv.data.SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/$/, '');

export const config = {
  ...parsedEnv.data,
  SUPABASE_URL: rawSupabaseUrl,
  isLiveBotSailor: !parsedEnv.data.BOTSAILOR_API_KEY.includes('mock'),
  isLiveSupabase: !rawSupabaseUrl.includes('mock') && rawSupabaseUrl.startsWith('http'),
  adminPhoneList: parsedEnv.data.ADMIN_PHONES.split(',').map((p) => p.trim().replace(/\D/g, '')),
};
