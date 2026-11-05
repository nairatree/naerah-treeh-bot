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

const MOCK_VARIANTS: ProductVariant[] = [
  // Wooden Chopping Board Variants
  { id: 'var-1', product_id: 'prod-1', sku: 'KT-CHOP-MED-NAT', size: 'Medium (30x20cm)', color: 'Natural Wood', price: 8500, stock_quantity: 50, is_available: true },
  { id: 'var-2', product_id: 'prod-1', sku: 'KT-CHOP-MED-RED', size: 'Medium (30x20cm)', color: 'Red Rim', price: 8500, stock_quantity: 45, is_available: true },
  { id: 'var-3', product_id: 'prod-1', sku: 'KT-CHOP-LRG-NAT', size: 'Large (40x28cm)', color: 'Natural Wood', price: 12000, stock_quantity: 30, is_available: true },
  { id: 'var-4', product_id: 'prod-1', sku: 'KT-CHOP-LRG-BLU', size: 'Large (40x28cm)', color: 'Blue Rim', price: 12000, stock_quantity: 25, is_available: true },

  // Knapsack Sprayer Variants
  { id: 'var-5', product_id: 'prod-2', sku: 'AG-SPRAY-16L-BLU', size: '16 Litres', color: 'Electric Blue', price: 28000, stock_quantity: 40, is_available: true },
  { id: 'var-6', product_id: 'prod-2', sku: 'AG-SPRAY-16L-YEL', size: '16 Litres', color: 'Safety Yellow', price: 28000, stock_quantity: 35, is_available: true },
  { id: 'var-7', product_id: 'prod-2', sku: 'AG-SPRAY-20L-BLU', size: '20 Litres Jumbo', color: 'Electric Blue', price: 34000, stock_quantity: 20, is_available: true },
  { id: 'var-8', product_id: 'prod-2', sku: 'AG-SPRAY-20L-YEL', size: '20 Litres Jumbo', color: 'Safety Yellow', price: 34000, stock_quantity: 18, is_available: true },

  // Spin Mop Variants
  { id: 'var-9', product_id: 'prod-3', sku: 'HM-MOP-STD-PUR', size: 'Standard 8L Bucket', color: 'Royal Purple', price: 14500, stock_quantity: 60, is_available: true },
  { id: 'var-10', product_id: 'prod-3', sku: 'HM-MOP-STD-BLU', size: 'Standard 8L Bucket', color: 'Ocean Blue', price: 14500, stock_quantity: 50, is_available: true },
];

const MOCK_PRODUCTS: Product[] = [
  {
    id: 'prod-1',
    category_id: 'cat-1',
    category_name: 'Kitchen Wares',
    name: 'Premium Wooden Chopping Board',
    slug: 'premium-wooden-chopping-board',
    sku: 'KT-CHOP-01',
    description: 'High-density, durable hardwood chopping board with anti-bacterial juice groove and ergonomic carry handle. Easy to clean and knife-friendly.',
    base_price: 8500,
    media_urls: ['https://images.unsplash.com/photo-1590794056226-79ef3a8147e1?w=800'],
    is_available: true,
    tags: ['kitchen', 'chopping board', 'wood', 'cutting board', 'tray', 'plate'],
  },
  {
    id: 'prod-2',
    category_id: 'cat-2',
    category_name: 'Agricultural Tools',
    name: 'Heavy-Duty 2-in-1 Knapsack Sprayer',
    slug: 'heavy-duty-knapsack-sprayer',
    sku: 'AG-SPRAY-01',
    description: 'Rechargeable electric and manual backpack sprayer with brass lance, high-pressure pump, and interchangeable nozzles. Ideal for crops, gardens, and fumigation.',
    base_price: 28000,
    media_urls: ['https://images.unsplash.com/photo-1592417817098-8f3d6910985c?w=800'],
    is_available: true,
    tags: ['agriculture', 'sprayer', 'knapsack', 'farming', 'crops', 'fumigation'],
  },
  {
    id: 'prod-3',
    category_id: 'cat-3',
    category_name: 'Home & Cleaning',
    name: 'Stainless Steel 360 Spin Mop & Bucket',
    slug: 'spin-mop-bucket-set',
    sku: 'HM-MOP-01',
    description: 'Microfiber rotating mop head with durable stainless-steel drying basket, dual-action washing bucket, and drain plug.',
    base_price: 14500,
    media_urls: ['https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=800'],
    is_available: true,
    tags: ['cleaning', 'mop', 'bucket', 'spin mop', 'home'],
  },
];

const MOCK_ORDERS: Order[] = [
  {
    id: 'ord-1',
    order_number: 'NT-2026-1001',
    customer_name: 'Chinedu Okafor',
    customer_phone: '2348031234567',
    delivery_address: '14 Admiralty Way, Lekki Phase 1',
    city_state: 'Lagos State',
    items: [
      {
        product_id: 'prod-1',
        product_name: 'Premium Wooden Chopping Board',
        variant_id: 'var-2',
        size: 'Medium (30x20cm)',
        color: 'Red Rim',
        unit_price: 8500,
        quantity: 1,
        subtotal: 8500,
      },
    ],
    total_amount: 8500,
    payment_method: 'POD',
    payment_status: 'UNPAID',
    order_status: 'CONFIRMED',
    created_at: new Date(Date.now() - 3600000 * 4).toISOString(),
  },
  {
    id: 'ord-2',
    order_number: 'NT-2026-1002',
    customer_name: 'Fatima Aliyu',
    customer_phone: '2348098765432',
    delivery_address: 'Plot 45 Gana Street, Maitama',
    city_state: 'Abuja FCT',
    items: [
      {
        product_id: 'prod-2',
        product_name: 'Heavy-Duty 2-in-1 Knapsack Sprayer',
        variant_id: 'var-7',
        size: '20 Litres Jumbo',
        color: 'Electric Blue',
        unit_price: 34000,
        quantity: 1,
        subtotal: 34000,
      },
    ],
    total_amount: 34000,
    payment_method: 'BANK_TRANSFER',
    payment_status: 'PENDING_VERIFICATION',
    order_status: 'PENDING',
    created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
  },
];

let supabaseInstance: SupabaseClient | null = null;

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
    if (supabaseInstance) {
      const { data, error } = await supabaseInstance
        .from('products')
        .select('*, variants:product_variants(*)')
        .or(`name.ilike.%${cleanQuery}%,description.ilike.%${cleanQuery}%,category_name.ilike.%${cleanQuery}%`)
        .limit(10);
      if (!error && data && data.length > 0) return data as Product[];
    }

    // In-memory smart search: filter out common stop words
    const stopWords = new Set(['i', 'want', 'need', 'to', 'buy', 'get', 'a', 'an', 'the', 'is', 'for', 'in', 'of', 'and', 'or', 'please', 'me']);
    const keywords = cleanQuery
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2 && !stopWords.has(w));

    const scored = MOCK_PRODUCTS.map((p) => {
      const nameLower = p.name.toLowerCase();
      const descLower = p.description.toLowerCase();
      const catLower = p.category_name.toLowerCase();
      const tagsLower = (p.tags || []).join(' ').toLowerCase();

      let score = 0;
      // Exact substring match gives high priority
      if (nameLower.includes(cleanQuery)) score += 50;
      if (catLower.includes(cleanQuery)) score += 30;

      // Score per matching keyword
      for (const kw of keywords) {
        if (nameLower.includes(kw)) score += 15;
        if (tagsLower.includes(kw)) score += 10;
        if (descLower.includes(kw)) score += 5;
        if (catLower.includes(kw)) score += 8;
      }

      return { product: p, score };
    });

    return scored
      .filter((s) => s.score > 0)
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
};
