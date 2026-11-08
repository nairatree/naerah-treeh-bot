import { db } from '../../database/supabaseClient.ts';
import { logger } from '../../utils/logger.ts';

/**
 * LAYER 5: Global Master Bot Settings Singleton (Killswitch)
 */
class SystemSettings {
  async isBotGloballyActive(): Promise<boolean> {
    try {
      const settings = await db.getStoreSettings();
      return settings.is_bot_active !== false;
    } catch (err: any) {
      logger.error('Failed to read global bot active status:', err.message);
      return true; // fail-safe default to active
    }
  }

  async setBotGloballyActive(active: boolean, reason?: string): Promise<void> {
    try {
      await db.updateStoreSettings({ is_bot_active: active });
      logger.info(
        `[MASTER KILLSWITCH] Bot globally set to ${active ? 'ACTIVE' : 'PAUSED'}${reason ? ` (Reason: ${reason})` : ''}`
      );
    } catch (err: any) {
      logger.error('Failed to update global bot active status:', err.message);
      throw err;
    }
  }
}

export const systemSettings = new SystemSettings();
