-- ==============================================================================
-- NAIRATEE STORES - E-COMMERCE DATABASE SCHEMA & SEED DATA
-- Fully supports Categories, Products, Multi-Variant Options (Size/Color/Price),
-- Customer Orders (POD & Bank Transfer), and Store Configuration
-- ==============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. CATEGORIES TABLE
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    slug VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    icon_emoji VARCHAR(10) DEFAULT '📦',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. PRODUCTS TABLE
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    category_name VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    sku VARCHAR(100) UNIQUE,
    description TEXT NOT NULL,
    base_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    media_urls JSONB DEFAULT '[]'::jsonb, -- Array of image/video URLs
    is_available BOOLEAN DEFAULT TRUE,
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Full-text search index on products
CREATE INDEX IF NOT EXISTS idx_products_search ON products USING gin(to_tsvector('english', name || ' ' || description || ' ' || category_name));
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_name);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);

-- 3. PRODUCT VARIANTS TABLE (Colors, Sizes, Custom Pricing)
CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku VARCHAR(100) UNIQUE,
    size VARCHAR(50),      -- e.g. 'Small', 'Medium', 'Large', '16 Litres', '20 Litres'
    color VARCHAR(50),     -- e.g. 'Blue', 'Red', 'Natural Teak Wood', 'Yellow'
    price NUMERIC(12, 2) NOT NULL, -- Variant-specific price
    stock_quantity INT DEFAULT 100,
    media_url TEXT,        -- Specific image for this color/variant
    is_available BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_variants_product_id ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_color ON product_variants(color);
CREATE INDEX IF NOT EXISTS idx_variants_size ON product_variants(size);

-- 4. ORDERS TABLE
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number VARCHAR(50) NOT NULL UNIQUE, -- e.g. 'NT-2026-1001'
    customer_name VARCHAR(150) NOT NULL,
    customer_phone VARCHAR(50) NOT NULL,
    delivery_address TEXT NOT NULL,
    city_state VARCHAR(100),
    items JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ product_id, variant_id, name, color, size, price, quantity }]
    total_amount NUMERIC(12, 2) NOT NULL,
    payment_method VARCHAR(30) NOT NULL CHECK (payment_method IN ('POD', 'BANK_TRANSFER')),
    payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PENDING_VERIFICATION', 'PAID')),
    order_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (order_status IN ('PENDING', 'CONFIRMED', 'DISPATCHED', 'DELIVERED', 'CANCELLED')),
    transfer_receipt_url TEXT,
    customer_notes TEXT,
    internal_admin_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_method ON orders(payment_method);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

-- 5. STORE SETTINGS / CONFIGURATION
CREATE TABLE IF NOT EXISTS store_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- INITIAL SEED DATA
-- ==============================================================================

-- Seed Categories
INSERT INTO categories (id, name, slug, description, icon_emoji) VALUES
('c1000000-0000-0000-0000-000000000001', 'Kitchen Wares', 'kitchen-wares', 'Chopping boards, pots, pans, organizers, and cooking tools', '🍳'),
('c1000000-0000-0000-0000-000000000002', 'Agricultural Tools', 'agricultural-tools', 'Knapsack sprayers, weeders, pruners, and farming gear', '🌾'),
('c1000000-0000-0000-0000-000000000003', 'Home & Cleaning', 'home-cleaning', 'Floor mops, scrubbers, storage racks, and cleaning essentials', '🧹')
ON CONFLICT (name) DO NOTHING;

-- Seed Sample Products with Multi-Variants
-- 1. Wooden Chopping Board (Kitchen)
INSERT INTO products (id, category_id, category_name, name, slug, sku, description, base_price, media_urls, tags) VALUES
('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'Kitchen Wares', 'Premium Wooden Chopping Board', 'premium-wooden-chopping-board', 'KT-CHOP-01', 'High-density, durable hardwood chopping board with anti-bacterial juice groove and ergonomic carry handle. Easy to clean and knife-friendly.', 8500.00, '["https://images.unsplash.com/photo-1590794056226-79ef3a8147e1?w=800"]'::jsonb, ARRAY['kitchen', 'chopping board', 'wood', 'cutting board', 'tray'])
ON CONFLICT (sku) DO NOTHING;

-- Variants for Chopping Board: Sizes (Medium, Large) and Colors (Natural Wood, Dark Oak, Red Accent)
INSERT INTO product_variants (product_id, sku, size, color, price, stock_quantity) VALUES
('b1000000-0000-0000-0000-000000000001', 'KT-CHOP-MED-NAT', 'Medium (30x20cm)', 'Natural Wood', 8500.00, 50),
('b1000000-0000-0000-0000-000000000001', 'KT-CHOP-MED-RED', 'Medium (30x20cm)', 'Red Rim', 8500.00, 45),
('b1000000-0000-0000-0000-000000000001', 'KT-CHOP-LRG-NAT', 'Large (40x28cm)', 'Natural Wood', 12000.00, 30),
('b1000000-0000-0000-0000-000000000001', 'KT-CHOP-LRG-BLU', 'Large (40x28cm)', 'Blue Rim', 12000.00, 25)
ON CONFLICT (sku) DO NOTHING;

-- 2. Agricultural Knapsack Sprayer (Agricultural Tools)
INSERT INTO products (id, category_id, category_name, name, slug, sku, description, base_price, media_urls, tags) VALUES
('b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'Agricultural Tools', 'Heavy-Duty 2-in-1 Knapsack Sprayer', 'heavy-duty-knapsack-sprayer', 'AG-SPRAY-01', 'Rechargeable electric and manual backpack sprayer with brass lance, high-pressure pump, and interchangeable nozzles. Ideal for crops, gardens, and fumigation.', 28000.00, '["https://images.unsplash.com/photo-1592417817098-8f3d6910985c?w=800"]'::jsonb, ARRAY['agriculture', 'sprayer', 'knapsack', 'farming', 'crops', 'fumigation'])
ON CONFLICT (sku) DO NOTHING;

-- Variants for Sprayer: Capacity (16 Litres, 20 Litres) and Colors (Yellow, Blue)
INSERT INTO product_variants (product_id, sku, size, color, price, stock_quantity) VALUES
('b1000000-0000-0000-0000-000000000002', 'AG-SPRAY-16L-BLU', '16 Litres', 'Electric Blue', 28000.00, 40),
('b1000000-0000-0000-0000-000000000002', 'AG-SPRAY-16L-YEL', '16 Litres', 'Safety Yellow', 28000.00, 35),
('b1000000-0000-0000-0000-000000000002', 'AG-SPRAY-20L-BLU', '20 Litres Jumbo', 'Electric Blue', 34000.00, 20),
('b1000000-0000-0000-0000-000000000002', 'AG-SPRAY-20L-YEL', '20 Litres Jumbo', 'Safety Yellow', 34000.00, 18)
ON CONFLICT (sku) DO NOTHING;

-- 3. 360-Degree Spin Mop (Home & Cleaning)
INSERT INTO products (id, category_id, category_name, name, slug, sku, description, base_price, media_urls, tags) VALUES
('b1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', 'Home & Cleaning', 'Stainless Steel 360 Spin Mop & Bucket', 'spin-mop-bucket-set', 'HM-MOP-01', 'Microfiber rotating mop head with durable stainless-steel drying basket, dual-action washing bucket, and drain plug.', 14500.00, '["https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=800"]'::jsonb, ARRAY['cleaning', 'mop', 'bucket', 'spin mop', 'home'])
ON CONFLICT (sku) DO NOTHING;

INSERT INTO product_variants (product_id, sku, size, color, price, stock_quantity) VALUES
('b1000000-0000-0000-0000-000000000003', 'HM-MOP-STD-PUR', 'Standard 8L Bucket', 'Royal Purple', 14500.00, 60),
('b1000000-0000-0000-0000-000000000003', 'HM-MOP-STD-BLU', 'Standard 8L Bucket', 'Ocean Blue', 14500.00, 50)
ON CONFLICT (sku) DO NOTHING;

-- Seed Default Store Settings
INSERT INTO store_settings (key, value, description) VALUES
('bank_details', '{
    "bank_name": "Access Bank",
    "account_number": "0123456789",
    "account_name": "Nairatee Stores Enterprise"
}'::jsonb, 'Official bank transfer payment details sent to customers'),
('store_info', '{
    "store_name": "Nairatee Stores",
    "support_phone": "2348000000000",
    "admin_phones": ["2348000000000"],
    "delivery_policy": "Delivery within 24-48 hours across major cities. Pay on Delivery available."
}'::jsonb, 'Store branding and support contact configuration')
ON CONFLICT (key) DO NOTHING;
