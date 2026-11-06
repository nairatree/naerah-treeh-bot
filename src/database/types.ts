export interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  icon_emoji?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  sku: string;
  size?: string | null;
  color?: string | null;
  price: number;
  stock_quantity: number;
  media_url?: string | null;
  is_available: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Product {
  id: string;
  category_id?: string | null;
  category_name: string;
  name: string;
  slug: string;
  sku?: string | null;
  description: string;
  base_price: number;
  media_urls: string[];
  is_available: boolean;
  tags?: string[];
  metadata?: Record<string, any>;
  variants?: ProductVariant[];
  created_at?: string;
  updated_at?: string;
}

export type PaymentMethod = 'POD' | 'BANK_TRANSFER';
export type PaymentStatus = 'UNPAID' | 'PENDING_VERIFICATION' | 'PAID';
export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'DISPATCHED' | 'DELIVERED' | 'CANCELLED';

export interface OrderItem {
  product_id: string;
  product_name: string;
  variant_id?: string | null;
  size?: string | null;
  color?: string | null;
  unit_price: number;
  quantity: number;
  subtotal: number;
}

export interface Order {
  id: string;
  order_number: string;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  city_state?: string | null;
  items: OrderItem[];
  total_amount: number;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  order_status: OrderStatus;
  transfer_receipt_url?: string | null;
  customer_notes?: string | null;
  internal_admin_notes?: string | null;
  created_at: string;
  updated_at?: string;
}

export type ConversationState =
  | 'IDLE'
  | 'BROWSING_PRODUCTS'
  | 'SELECTING_VARIANT'
  | 'AWAITING_QUANTITY'
  | 'AWAITING_DELIVERY_DETAILS'
  | 'HANDED_OVER_TO_SUPPORT';

export interface ConversationContext {
  lastActiveTime: number;
  currentProductId?: string;
  currentProduct?: Product;
  selectedVariantId?: string;
  selectedVariant?: ProductVariant;
  selectedQuantity?: number;
  pendingOrderNumber?: string;
  temporaryAddressDraft?: string;
}

export interface CustomerLead {
  phoneNumber: string;
  userName?: string;
  productId?: string;
  productName: string;
  variantId?: string;
  variantDesc?: string;
  quantity?: number;
  lastInteractionAt: number;
  followupCount: number;
  status: 'PENDING_ADDRESS' | 'PURCHASED' | 'OPTED_OUT' | 'EXPIRED';
  lastFollowupAt?: number;
}

export interface ChatSession {
  phoneNumber: string;
  userName?: string;
  state: ConversationState;
  context: ConversationContext;
  updatedAt: number;
}
