import crypto from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/environment.ts';
import { logger } from '../utils/logger.ts';
import type { Product, ProductVariant, Order, Category } from './types.ts';

// In-Memory Fallback Seed Data (Used when Supabase is not connected yet)
const MOCK_CATEGORIES: Category[] = [
  { id: 'cat-1', name: 'Kitchen Wares', slug: 'kitchen-wares', description: 'Chopping boards, pots, pans, organizers', icon_emoji: '🍳' },
  { id: 'cat-2', name: 'Agricultural Tools', slug: 'agricultural-tools', description: 'Knapsack sprayers, weeders, farming gear', icon_emoji: '🌾' },
  { id: 'cat-3', name: 'Home & Cleaning', slug: 'home-cleaning', description: 'Spin mops, cleaning essentials', icon_emoji: '🧹' },
];

const MOCK_VARIANTS: ProductVariant[] = [];

const MOCK_PRODUCTS: Product[] = [];

const MOCK_ORDERS: Order[] = [];

let supabaseInstance: SupabaseClient | null = null;
let cachedSettings: Record<string, any> | null = null;
let settingsCacheExpiry = 0;

if (config.isLiveSupabase) {
  try {
    const key = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY;
    supabaseInstance = createClient(config.SUPABASE_URL, key, {
      auth: { persistSession: false },
    });
    logger.info('Supabase client initialized with live credentials.');
  } catch (err: any) {
    logger.error('Failed to initialize Supabase client:', err.message);
  }
} else {
  logger.info('Using Mock In-Memory Database for catalog & orders (Live Supabase credentials not yet supplied).');
}

export const db = {
  isLive: !!supabaseInstance,

  async getCategories(): Promise<Category[]> {
    if (supabaseInstance) {
      const { data, error } = await supabaseInstance.from('categories').select('*').order('name');
      if (!error && data) return data as Category[];
    }
    return MOCK_CATEGORIES;
  },

  async getProducts(): Promise<Product[]> {
    if (supabaseInstance) {
      const { data, error } = await supabaseInstance.from('products').select('*, variants:product_variants(*)').order('created_at', { ascending: false });
      if (!error && data) return data as Product[];
    }
    return MOCK_PRODUCTS.map((p) => ({
      ...p,
      variants: MOCK_VARIANTS.filter((v) => v.product_id === p.id),
    }));
  },

  async getProductById(id: string): Promise<Product | null> {
    if (supabaseInstance) {
      const { data, error } = await supabaseInstance.from('products').select('*, variants:product_variants(*)').eq('id', id).single();
      if (!error && data) return data as Product;
    }
    const found = MOCK_PRODUCTS.find((p) => p.id === id);
    if (!found) return null;
    return {
      ...found,
      variants: MOCK_VARIANTS.filter((v) => v.product_id === found.id),
    };
  },

  async searchProducts(query: string): Promise<Product[]> {
    const cleanQuery = query.toLowerCase().trim();
    if (!cleanQuery || cleanQuery.length < 2) return [];

    const stopWords = new Set([
      'i', 'want', 'need', 'to', 'buy', 'get', 'a', 'an', 'the', 'is', 'for', 'in', 'of', 'and', 'or',
      'please', 'me', 'you', 'your', 'my', 'he', 'she', 'it', 'they', 'we', 'are', 'were', 'was', 'am',
      'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could', 'will', 'would',
      'shall', 'should', 'how', 'much', 'many', 'what', 'where', 'when', 'who', 'why', 'bro', 'guys',
      'guy', 'dear', 'sir', 'ma', 'okay', 'ok', 'yes', 'no', 'hi', 'hello', 'hey', 'good', 'morning',
      'afternoon', 'evening', 'night', 'today', 'now', 'right', 'there', 'here', 'just', 'still', 'dey',
      'abeg', 'pls', 'send', 'tell', 'show', 'give', 'hope', 'fine', 'call', 'see', 'around'
    ]);

    const keywords = cleanQuery
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !stopWords.has(w));

    // If query contains only stop words / conversational terms, do not attempt fuzzy matching
    if (keywords.length === 0 && !cleanQuery.includes('board') && !cleanQuery.includes('sprayer') && !cleanQuery.includes('mop')) {
      return [];
    }

    if (supabaseInstance) {
      // 1. Direct match on clean query
      const { data, error } = await supabaseInstance
        .from('products')
        .select('*, variants:product_variants(*)')
        .or(`name.ilike.%${cleanQuery}%,description.ilike.%${cleanQuery}%`)
        .limit(10);
      if (!error && data && data.length > 0) return data as Product[];

      // 2. Keyword match if significant keywords exist
      if (keywords.length > 0) {
        const orConditions = keywords.map((kw) => `name.ilike.%${kw}%`).join(',');
        const { data: kwData, error: kwError } = await supabaseInstance
          .from('products')
          .select('*, variants:product_variants(*)')
          .or(orConditions)
          .limit(10);
        if (!kwError && kwData && kwData.length > 0) return kwData as Product[];
      }
      return [];
    }

    // In-memory fallback
    const scored = MOCK_PRODUCTS.map((p) => {
      const nameLower = p.name.toLowerCase();
      const tagsLower = (p.tags || []).map((t) => t.toLowerCase());

      let score = 0;
      // Exact substring match gives high priority
      if (nameLower.includes(cleanQuery)) score += 50;
      if (tagsLower.some((t) => t.includes(cleanQuery) || cleanQuery.includes(t))) score += 40;

      // Score per matching keyword with word boundary regex (no random substring matches)
      for (const kw of keywords) {
        const regex = new RegExp(`\\b${kw}`, 'i');
        if (regex.test(nameLower)) score += 20;
        if (tagsLower.some((t) => regex.test(t))) score += 15;
      }

      return { product: p, score };
    });

    // Require minimum threshold score to avoid false positives on casual words
    return scored
      .filter((s) => s.score >= 20)
      .sort((a, b) => b.score - a.score)
      .map((s) => ({
        ...s.product,
        variants: MOCK_VARIANTS.filter((v) => v.product_id === s.product.id),
      }));
  },

  async createProduct(productData: Partial<Product>, variantsData: Partial<ProductVariant>[] = []): Promise<Product> {
    const newId = crypto.randomUUID();
    const newProduct: Product = {
      id: newId,
      category_id: productData.category_id || null,
      category_name: productData.category_name || 'General',
      name: productData.name || 'New Product',
      slug: (productData.name || 'new-product').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      sku: productData.sku || `SKU-${Date.now()}`,
      description: productData.description || '',
      base_price: Number(productData.base_price) || 0,
      media_urls: productData.media_urls || [],
      is_available: true,
      tags: productData.tags || [],
      created_at: new Date().toISOString(),
    };

    if (supabaseInstance) {
      const { data, error } = await supabaseInstance.from('products').insert([newProduct]).select().single();
      if (error) {
        logger.error('Error inserting product in Supabase:', error.message);
      }
      if (!error && data) {
        if (variantsData.length > 0) {
          const formattedVariants = variantsData.map((v, idx) => ({
            id: crypto.randomUUID(),
            product_id: data.id,
            sku: v.sku || `${data.sku || 'SKU'}-VAR-${idx + 1}`,
            size: v.size || null,
            color: v.color || null,
            price: Number(v.price) || data.base_price,
            stock_quantity: v.stock_quantity ?? 50,
            is_available: true,
          }));
          const { error: varError } = await supabaseInstance.from('product_variants').insert(formattedVariants);
          if (varError) {
            logger.error('Error inserting variants in Supabase:', varError.message);
          }
        }
        return this.getProductById(data.id) as Promise<Product>;
      }
    }

    MOCK_PRODUCTS.unshift(newProduct);
    if (variantsData.length > 0) {
      variantsData.forEach((v, idx) => {
        MOCK_VARIANTS.push({
          id: `var-${Date.now()}-${idx}`,
          product_id: newId,
          sku: v.sku || `${newProduct.sku}-VAR-${idx + 1}`,
          size: v.size || null,
          color: v.color || null,
          price: Number(v.price) || newProduct.base_price,
          stock_quantity: v.stock_quantity ?? 50,
          media_url: v.media_url || null,
          is_available: true,
        });
      });
    }

    return {
      ...newProduct,
      variants: MOCK_VARIANTS.filter((v) => v.product_id === newId),
    };
  },

  async deleteProduct(productId: string): Promise<boolean> {
    if (supabaseInstance) {
      const { error } = await supabaseInstance.from('products').delete().eq('id', productId);
      return !error;
    }
    const idx = MOCK_PRODUCTS.findIndex((p) => p.id === productId);
    if (idx !== -1) {
      MOCK_PRODUCTS.splice(idx, 1);
      return true;
    }
    return false;
  },

  async getOrders(): Promise<Order[]> {
    if (supabaseInstance) {
      const { data, error } = await supabaseInstance.from('orders').select('*').order('created_at', { ascending: false });
      if (!error && data) return data as Order[];
    }
    return MOCK_ORDERS;
  },

  async getOrdersByPhone(phoneNumber: string): Promise<Order[]> {
    const cleanDigits = phoneNumber.replace(/\D/g, '');
    const last10 = cleanDigits.slice(-10);

    if (supabaseInstance) {
      const { data, error } = await supabaseInstance
        .from('orders')
        .select('*')
        .or(`customer_phone.ilike.%${last10}%,customer_phone.ilike.%${cleanDigits}%`)
        .order('created_at', { ascending: false })
        .limit(5);
      if (!error && data && data.length > 0) return data as Order[];
    }

    return MOCK_ORDERS.filter((o) => {
      const oDigits = (o.customer_phone || '').replace(/\D/g, '');
      return oDigits.endsWith(last10) || cleanDigits.endsWith(oDigits.slice(-10)) || oDigits === cleanDigits;
    });
  },

  async getOrderByNumber(orderNumber: string): Promise<Order | null> {
    const cleanRef = orderNumber.trim().toUpperCase();
    if (supabaseInstance) {
      const { data, error } = await supabaseInstance
        .from('orders')
        .select('*')
        .ilike('order_number', `%${cleanRef}%`)
        .limit(1)
        .maybeSingle();
      if (!error && data) return data as Order;
    }
    const found = MOCK_ORDERS.find((o) => o.order_number.toUpperCase().includes(cleanRef));
    return found || null;
  },

  async createOrder(orderData: Omit<Order, 'id' | 'created_at'>): Promise<Order> {
    const newOrder: Order = {
      ...orderData,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    };

    if (supabaseInstance) {
      const { data, error } = await supabaseInstance.from('orders').insert([newOrder]).select().single();
      if (error) {
        logger.error('Error inserting order in Supabase:', error.message);
      }
      if (!error && data) return data as Order;
    }

    MOCK_ORDERS.unshift(newOrder);
    return newOrder;
  },

  async updateOrderStatus(orderId: string, orderStatus: Order['order_status'], paymentStatus?: Order['payment_status']): Promise<Order | null> {
    if (supabaseInstance) {
      const updates: any = { order_status: orderStatus };
      if (paymentStatus) updates.payment_status = paymentStatus;
      const { data, error } = await supabaseInstance.from('orders').update(updates).eq('id', orderId).select().single();
      if (!error && data) return data as Order;
    }

    const order = MOCK_ORDERS.find((o) => o.id === orderId);
    if (order) {
      order.order_status = orderStatus;
      if (paymentStatus) order.payment_status = paymentStatus;
      return order;
    }
    return null;
  },

  async attachReceiptUrl(orderNumber: string, receiptUrl: string): Promise<boolean> {
    if (supabaseInstance) {
      const { error } = await supabaseInstance
        .from('orders')
        .update({ transfer_receipt_url: receiptUrl, payment_status: 'PENDING_VERIFICATION' })
        .eq('order_number', orderNumber);
      return !error;
    }

    const order = MOCK_ORDERS.find((o) => o.order_number === orderNumber);
    if (order) {
      order.transfer_receipt_url = receiptUrl;
      order.payment_status = 'PENDING_VERIFICATION';
      return true;
    }
    return false;
  },

  async getStoreSettings(): Promise<Record<string, any>> {
    // Fast in-memory cache check (15 seconds TTL) to eliminate Supabase latency on every WhatsApp message
    if (cachedSettings && Date.now() < settingsCacheExpiry) {
      return cachedSettings;
    }

    const defaults = {
      store_name: config.STORE_NAME,
      support_phone: config.SUPPORT_PHONE_NUMBER,
      whatsapp_group_link: '',
      bank_name: config.BANK_NAME,
      account_number: config.BANK_ACCOUNT_NUMBER,
      account_name: config.BANK_ACCOUNT_NAME,
      is_bot_active: false, // Default PAUSED as requested by merchant!
      trigger_mode: 'KEYWORD_ONLY',
    };

    if (supabaseInstance) {
      const { data, error } = await supabaseInstance.from('store_settings').select('*');
      if (!error && data) {
        const result: Record<string, any> = { ...defaults };
        data.forEach((row) => {
          if (row.key === 'bank_details' && typeof row.value === 'object') {
            result.bank_name = row.value.bank_name || result.bank_name;
            result.account_number = row.value.account_number || result.account_number;
            result.account_name = row.value.account_name || result.account_name;
          } else if (row.key === 'store_info' && typeof row.value === 'object') {
            result.store_name = row.value.store_name || result.store_name;
            result.support_phone = row.value.support_phone || result.support_phone;
            result.whatsapp_group_link = row.value.whatsapp_group_link || result.whatsapp_group_link;
            if (row.value.is_bot_active !== undefined) result.is_bot_active = row.value.is_bot_active;
            if (row.value.trigger_mode !== undefined) result.trigger_mode = row.value.trigger_mode;
          } else {
            result[row.key] = row.value;
          }
        });
        cachedSettings = result;
        settingsCacheExpiry = Date.now() + 15 * 1000;
        return result;
      }
    }

    cachedSettings = defaults;
    settingsCacheExpiry = Date.now() + 15 * 1000;
    return defaults;
  },

  async updateStoreSettings(settings: Record<string, any>): Promise<boolean> {
    const current = await this.getStoreSettings();
    const updated = { ...current, ...settings };
    cachedSettings = updated;
    settingsCacheExpiry = Date.now() + 15 * 1000;

    if (supabaseInstance) {
      if (settings.bank_name || settings.account_number || settings.account_name) {
        await supabaseInstance.from('store_settings').upsert({
          key: 'bank_details',
          value: {
            bank_name: updated.bank_name,
            account_number: updated.account_number,
            account_name: updated.account_name,
          },
          updated_at: new Date().toISOString(),
        });
      }

      await supabaseInstance.from('store_settings').upsert({
        key: 'store_info',
        value: {
          store_name: updated.store_name,
          support_phone: updated.support_phone,
          whatsapp_group_link: updated.whatsapp_group_link,
          is_bot_active: updated.is_bot_active,
          trigger_mode: updated.trigger_mode,
        },
        updated_at: new Date().toISOString(),
      });
      return true;
    }
    return true;
  },
};
