// Schema creation, migrations, indexes, and first-boot seed data.
import { pool, withTransaction } from './db.js';
import { TABLE_CONFIG, TABLES, insertRow } from './queries.js';
import { hashPassword } from './authUtils.js';

export async function initDb() {
  for (const t of TABLES) await pool.query(TABLE_CONFIG[t].ddl);
  // One order (= one POS checkout) gets one number, shared by every cup row it produced.
  await pool.query('CREATE SEQUENCE IF NOT EXISTS salefront_order_seq');
  await migrate();
  await migrateColumnTypes();
  await createIndexes();
  await seed();
}

// Databases created before this version stored every date/timestamp as TEXT.
// Upgrade them to real DATE/TIMESTAMPTZ columns (matching the ddl above) so
// range queries (?since/?until) and ORDER BY work correctly instead of doing
// lexicographic string comparison. NULLIF(...,'') guards old blank strings —
// plain ::date/::timestamptz would reject '' as invalid input. Idempotent: once
// a column is no longer 'text' this is a no-op, so it's cheap to run every boot.
const COLUMN_TYPE_MIGRATIONS = [
  ['salefront', 'date', 'date'], ['saledelivery', 'date', 'date'],
  ['stocklog', 'date', 'date'], ['expenses', 'date', 'date'],
  ['deliverydaily', 'date', 'date'],
  ['deliverymenu', 'period_start', 'date'], ['deliverymenu', 'period_end', 'date'],
  ['systemlog', 'created_at', 'timestamptz'], ['processed_txns', 'created_at', 'timestamptz'],
  ['redemptions', 'created_at', 'timestamptz'], ['redemptions', 'expires_at', 'timestamptz'],
  ['redemptions', 'used_at', 'timestamptz'],
  ['shifts', 'opened_at', 'timestamptz'], ['shifts', 'closed_at', 'timestamptz']
];

async function migrateColumnTypes() {
  for (const [table, column, type] of COLUMN_TYPE_MIGRATIONS) {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (rows[0]?.data_type !== 'text') continue; // already migrated (or column absent)
    try {
      await pool.query(
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type} USING NULLIF(${column}, '')::${type}`
      );
    } catch (e) {
      console.error(`Column-type migration failed for ${table}.${column} -> ${type}:`, e.message);
    }
  }
}

// Hot lookup paths: dashboard date windows, loyalty by customer, stock history,
// pending redeem codes. Runs after migrate() so new columns already exist.
async function createIndexes() {
  const stmts = [
    'CREATE INDEX IF NOT EXISTS idx_salefront_date ON salefront (date)',
    'CREATE INDEX IF NOT EXISTS idx_salefront_customer_name ON salefront (lower(customer_name))',
    'CREATE INDEX IF NOT EXISTS idx_salefront_customer_id ON salefront (customer_id)',
    'CREATE INDEX IF NOT EXISTS idx_salefront_shift ON salefront (shift_id)',
    'CREATE INDEX IF NOT EXISTS idx_stocklog_material ON stocklog (material_id)',
    // UNIQUE (not just an index): the redeem endpoint retries on a 23505
    // collision, but that only works if the DB actually rejects duplicates —
    // two pending codes with the same 6 digits must never coexist.
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_redemptions_pending_code ON redemptions (code) WHERE status = 'pending'",
    // Claim links must be unique; crm/spend rows have no token (NULL is exempt).
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_point_ledger_token ON point_ledger (token) WHERE token IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_point_ledger_customer ON point_ledger (customer_id)',
    "CREATE INDEX IF NOT EXISTS idx_pending_slips_status ON pending_slips (status)"
  ];
  for (const s of stmts) await pool.query(s);
}

// Add any columns present in TABLE_CONFIG but missing from an existing table.
async function migrate() {
  // Phase-2 runs FIRST, before the generic loop below: customer_id/menu_id
  // need real types (INTEGER FK, not TEXT). The generic loop adds anything
  // still missing as TEXT, so if it ran first it would create these columns
  // as TEXT and the typed ALTER below would then no-op (IF NOT EXISTS) —
  // silently leaving them the wrong type forever.
  // All additive (nullable), backfilled once from matching names/barcodes.
  for (const sql of [
    'ALTER TABLE salefront ADD COLUMN IF NOT EXISTS customer_id INTEGER',
    'ALTER TABLE saledelivery ADD COLUMN IF NOT EXISTS customer_id INTEGER',
    'ALTER TABLE expenses ADD COLUMN IF NOT EXISTS material_id TEXT',
    'ALTER TABLE bom ADD COLUMN IF NOT EXISTS menu_id TEXT',
    'ALTER TABLE childmenu ADD COLUMN IF NOT EXISTS menu_id TEXT'
  ]) {
    try { await pool.query(sql); } catch { /* ignore */ }
  }
  // One-time backfill: match existing name/barcode strings to their id.
  for (const sql of [
    `UPDATE salefront sf SET customer_id = c.id FROM customers c
       WHERE sf.customer_id IS NULL AND lower(sf.customer_name) = lower(c.name)`,
    `UPDATE saledelivery sd SET customer_id = c.id FROM customers c
       WHERE sd.customer_id IS NULL AND lower(sd.customer_name) = lower(c.name)`,
    `UPDATE expenses e SET material_id = m.id FROM materials m
       WHERE e.material_id IS NULL AND e.mat_barcode <> '' AND e.mat_barcode = m.mat_barcode`,
    `UPDATE bom b SET menu_id = m.id FROM menuname m
       WHERE b.menu_id IS NULL AND lower(b.menu_name) = lower(m.name)`,
    `UPDATE childmenu c SET menu_id = m.id FROM menuname m
       WHERE c.menu_id IS NULL AND lower(c.menu_name) = lower(m.name)`
  ]) {
    try { await pool.query(sql); } catch { /* ignore */ }
  }

  for (const t of TABLES) {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t]
    );
    const existing = rows.map(r => r.column_name);
    for (const col of TABLE_CONFIG[t].columns) {
      if (!existing.includes(col)) {
        try { await pool.query(`ALTER TABLE ${t} ADD COLUMN ${col} TEXT`); } catch { /* ignore */ }
      }
    }
  }

  // Phase-1 cleanup: drop dead objects that never carried live data.
  //  - `replenishments` was superseded by stocklog and never read/written.
  //  - `expenses.replenishment_id` was always null (referred to the dead table).
  //  - `settings.current_theme` was write-only; theme lives in localStorage.
  // All guarded with IF EXISTS so this stays idempotent across boots.
  for (const sql of [
    'DROP TABLE IF EXISTS replenishments',
    'ALTER TABLE expenses DROP COLUMN IF EXISTS replenishment_id',
    'ALTER TABLE settings DROP COLUMN IF EXISTS current_theme'
  ]) {
    try { await pool.query(sql); } catch { /* ignore */ }
  }

  // Phase-3: staff-assigned customer code (1 letter + 3 digits), unique so it can
  // reliably identify a customer regardless of what nickname they use on LINE.
  // Normalize the old free-text gender values ('male'/'female') to the M/F/NA
  // codes used going forward.
  for (const sql of [
    'ALTER TABLE customers ADD CONSTRAINT customers_code_unique UNIQUE (code)',
    "UPDATE customers SET gender = 'M' WHERE lower(gender) = 'male'",
    "UPDATE customers SET gender = 'F' WHERE lower(gender) = 'female'"
  ]) {
    try { await pool.query(sql); } catch { /* ignore (constraint already exists, etc.) */ }
  }

  // Phase-5: the legacy automatic stamp-card promotion type is gone — the
  // Promotions UI no longer offers it, and the server only ever reads
  // type='points'. Any shop whose database predates this rework may still
  // have an old type='stamp' row; convert it in place (buy_qty/max_free_value
  // mean the same thing for both types) so it becomes the active points promo
  // without the owner having to recreate it by hand.
  try {
    await pool.query("UPDATE promotions SET type = 'points' WHERE type = 'stamp'");
  } catch { /* ignore */ }

  // Phase-6: addons.kind existing rows predate the column (added as plain
  // TEXT with no default by the generic loop above) — backfill them to the
  // 'extra' meaning they always had. Then seed the container/sweetness
  // modifier rows once, converting the old hardcoded CONTAINERS array and
  // the settings.sweetness_levels CSV into real addons rows — only if a shop
  // has none yet, so this never overwrites values staff already edited.
  try {
    await pool.query("UPDATE addons SET kind = 'extra' WHERE kind IS NULL");
    const { rows: [{ c: containerCount }] } = await pool.query("SELECT COUNT(*)::int AS c FROM addons WHERE kind = 'container'");
    if (containerCount === 0) {
      for (const [name, price_change] of [['Ice', 0], ['Hot', 0], ['Bottle', -5]]) {
        await pool.query('INSERT INTO addons (name, price_change, kind) VALUES ($1, $2, $3)', [name, price_change, 'container']);
      }
    }
    const { rows: [{ c: sweetnessCount }] } = await pool.query("SELECT COUNT(*)::int AS c FROM addons WHERE kind = 'sweetness'");
    if (sweetnessCount === 0) {
      const { rows: [settingsRow] } = await pool.query('SELECT sweetness_levels FROM settings LIMIT 1');
      const levels = String(settingsRow?.sweetness_levels || 'No Sweet, 25%, 50%, 100%')
        .split(',').map(s => s.trim()).filter(Boolean);
      for (const name of levels) {
        await pool.query('INSERT INTO addons (name, price_change, kind) VALUES ($1, $2, $3)', [name, 0, 'sweetness']);
      }
    }
  } catch (e) {
    console.error('addons.kind seed migration failed:', e.message);
  }

  // Phase-4: Supabase flags any table without RLS as "Unrestricted" in its
  // dashboard. That only matters for Supabase's own REST/GraphQL API
  // (PostgREST) — this hub never uses it (it talks to Postgres directly via
  // DATABASE_URL, a superuser role that bypasses RLS regardless). Enabling
  // RLS with no policies closes that alternate access path with zero effect
  // on the app itself.
  for (const sql of TABLES.map(t => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`)) {
    try { await pool.query(sql); } catch { /* ignore */ }
  }
}

async function seed() {
  const { rows } = await pool.query('SELECT COUNT(*) c FROM users');
  if (Number(rows[0].c) > 0) return; // already seeded

  await withTransaction(async (client) => {
    await insertRow('users', {
      username: 'admin', password: await hashPassword('admin'),
      access: 'dashboard,pos,delivery,materials,stock,bom,expenses,customers,users,daily,settings,promotions,points',
      role: 'Admin'
    }, client);
    await insertRow('users', {
      username: 'staff', password: await hashPassword('staff'),
      access: 'dashboard,pos,delivery,customers,daily,settings', role: 'User'
    }, client);

    await insertRow('settings', {
      sweetness_levels: 'No Sweet, 25%, 50%, 100%',
      buyers: 'Admin, Staff, Buyer A', logo: null
    }, client);

    const materials = [
      { id: 'MAT001', category: 'Beans', brand: 'Arabica Premium', item: 'Beans 500g', qty: 500, unit: 'g', price: 350, yield: 95, current_stock: 5000, min_stock: 1000, status: 'Active', mat_barcode: '8850123456789', name: 'Arabica Premium Beans 500g', unit_price: 0.737 },
      { id: 'MAT002', category: 'Dairy', brand: 'Meiji', item: 'Milk 2L', qty: 2000, unit: 'ml', price: 95, yield: 100, current_stock: 10000, min_stock: 2000, status: 'Active', mat_barcode: '8850123456790', name: 'Meiji Milk 2L', unit_price: 0.0475 },
      { id: 'MAT003', category: 'Powder', brand: 'Van Houten', item: 'Cocoa 500g', qty: 500, unit: 'g', price: 280, yield: 98, current_stock: 2000, min_stock: 500, status: 'Active', mat_barcode: '8850123456791', name: 'Van Houten Cocoa 500g', unit_price: 0.571 },
      { id: 'MAT004', category: 'Sweetener', brand: 'Mitr Phol', item: 'Syrup 1L', qty: 1000, unit: 'ml', price: 60, yield: 100, current_stock: 5000, min_stock: 1000, status: 'Active', mat_barcode: '8850123456792', name: 'Mitr Phol Syrup 1L', unit_price: 0.06 },
      { id: 'MAT005', category: 'Packaging', brand: 'KOTEA', item: 'Cups 50pcs', qty: 50, unit: 'pcs', price: 75, yield: 100, current_stock: 500, min_stock: 100, status: 'Active', mat_barcode: '8850123456793', name: 'KOTEA Cups 50pcs', unit_price: 1.5 },
      { id: 'MAT006', category: 'Packaging', brand: 'KOTEA', item: 'Straws 100pcs', qty: 100, unit: 'pcs', price: 30, yield: 100, current_stock: 1000, min_stock: 200, status: 'Active', mat_barcode: '8850123456794', name: 'KOTEA Straws 100pcs', unit_price: 0.3 },
      { id: 'MAT007', category: 'Beans', brand: 'Robusta Dark', item: 'Beans 1kg', qty: 1000, unit: 'g', price: 420, yield: 92, current_stock: 3000, min_stock: 800, status: 'Active', mat_barcode: '8850123456795', name: 'Robusta Dark Beans 1kg', unit_price: 0.456 },
      { id: 'MAT008', category: 'Dairy', brand: 'Lactasoy', item: 'Oat Milk 1L', qty: 1000, unit: 'ml', price: 85, yield: 100, current_stock: 8000, min_stock: 1500, status: 'Active', mat_barcode: '8850123456796', name: 'Lactasoy Oat Milk 1L', unit_price: 0.085 },
      { id: 'MAT009', category: 'Tea', brand: 'Thai Tea', item: 'Tea Mix 500g', qty: 500, unit: 'g', price: 180, yield: 96, current_stock: 2500, min_stock: 600, status: 'Active', mat_barcode: '8850123456797', name: 'Thai Tea Mix 500g', unit_price: 0.375 },
      { id: 'MAT010', category: 'Powder', brand: 'Nestle', item: 'Malt Powder 500g', qty: 500, unit: 'g', price: 220, yield: 99, current_stock: 1800, min_stock: 400, status: 'Active', mat_barcode: '8850123456798', name: 'Nestle Malt Powder 500g', unit_price: 0.443 },
      { id: 'MAT011', category: 'Sweetener', brand: 'Golden Sugar', item: 'Brown Sugar 1kg', qty: 1000, unit: 'g', price: 45, yield: 100, current_stock: 4000, min_stock: 800, status: 'Active', mat_barcode: '8850123456799', name: 'Golden Sugar Brown Sugar 1kg', unit_price: 0.045 },
      { id: 'MAT012', category: 'Spices', brand: 'Thai Spice', item: 'Cardamom 100g', qty: 100, unit: 'g', price: 120, yield: 95, current_stock: 500, min_stock: 150, status: 'Active', mat_barcode: '8850123456800', name: 'Thai Spice Cardamom 100g', unit_price: 1.263 },
      { id: 'MAT013', category: 'Packaging', brand: 'PakLid', item: 'Lids 500pcs', qty: 500, unit: 'pcs', price: 90, yield: 100, current_stock: 800, min_stock: 200, status: 'Active', mat_barcode: '8850123456801', name: 'PakLid Lids 500pcs', unit_price: 0.18 },
      { id: 'MAT014', category: 'Beans', brand: 'Kenya AA', item: 'Beans 250g', qty: 250, unit: 'g', price: 280, yield: 94, current_stock: 2000, min_stock: 500, status: 'Active', mat_barcode: '8850123456802', name: 'Kenya AA Beans 250g', unit_price: 1.191 },
      { id: 'MAT015', category: 'Dairy', brand: 'Emborg', item: 'Milk Cream 200ml', qty: 200, unit: 'ml', price: 120, yield: 98, current_stock: 3000, min_stock: 600, status: 'Active', mat_barcode: '8850123456803', name: 'Emborg Milk Cream 200ml', unit_price: 0.612 },
      { id: 'MAT016', category: 'Tea', brand: 'Cha Yen', item: 'Cha Yen Mix 1kg', qty: 1000, unit: 'g', price: 320, yield: 95, current_stock: 1500, min_stock: 400, status: 'Active', mat_barcode: '8850123456804', name: 'Cha Yen Mix 1kg', unit_price: 0.337 },
      { id: 'MAT017', category: 'Powder', brand: 'Marigold', item: 'Matcha 250g', qty: 250, unit: 'g', price: 450, yield: 99, current_stock: 800, min_stock: 200, status: 'Active', mat_barcode: '8850123456805', name: 'Marigold Matcha 250g', unit_price: 1.818 },
      { id: 'MAT018', category: 'Sweetener', brand: 'Honey Pure', item: 'Honey 500ml', qty: 500, unit: 'ml', price: 180, yield: 100, current_stock: 1200, min_stock: 300, status: 'Active', mat_barcode: '8850123456806', name: 'Honey Pure Honey 500ml', unit_price: 0.36 },
      { id: 'MAT019', category: 'Spices', brand: 'Vanilla Box', item: 'Vanilla Extract 100ml', qty: 100, unit: 'ml', price: 250, yield: 100, current_stock: 400, min_stock: 100, status: 'Active', mat_barcode: '8850123456807', name: 'Vanilla Box Vanilla Extract 100ml', unit_price: 2.5 },
      { id: 'MAT020', category: 'Packaging', brand: 'EcoCup', item: 'Paper Cups 500pcs', qty: 500, unit: 'pcs', price: 110, yield: 100, current_stock: 600, min_stock: 150, status: 'Active', mat_barcode: '8850123456808', name: 'EcoCup Paper Cups 500pcs', unit_price: 0.22 },
      { id: 'MAT021', category: 'Beans', brand: 'Ethiopian Yirgacheffe', item: 'Beans 200g', qty: 200, unit: 'g', price: 320, yield: 93, current_stock: 1500, min_stock: 400, status: 'Active', mat_barcode: '8850123456809', name: 'Ethiopian Yirgacheffe Beans 200g', unit_price: 1.720 },
      { id: 'MAT022', category: 'Dairy', brand: 'Almond Pro', item: 'Almond Milk 1L', qty: 1000, unit: 'ml', price: 95, yield: 100, current_stock: 5000, min_stock: 1000, status: 'Active', mat_barcode: '8850123456810', name: 'Almond Pro Almond Milk 1L', unit_price: 0.095 },
      { id: 'MAT023', category: 'Tea', brand: 'Green Leaf', item: 'Green Tea 300g', qty: 300, unit: 'g', price: 150, yield: 97, current_stock: 1800, min_stock: 500, status: 'Active', mat_barcode: '8850123456811', name: 'Green Leaf Green Tea 300g', unit_price: 0.515 },
      { id: 'MAT024', category: 'Powder', brand: 'Choco Star', item: 'Chocolate Powder 1kg', qty: 1000, unit: 'g', price: 380, yield: 96, current_stock: 2200, min_stock: 600, status: 'Active', mat_barcode: '8850123456812', name: 'Choco Star Chocolate Powder 1kg', unit_price: 0.396 },
      { id: 'MAT025', category: 'Sweetener', brand: 'Stevia Sweet', item: 'Stevia 200g', qty: 200, unit: 'g', price: 140, yield: 100, current_stock: 900, min_stock: 250, status: 'Active', mat_barcode: '8850123456813', name: 'Stevia Sweet Stevia 200g', unit_price: 0.7 },
      { id: 'MAT026', category: 'Spices', brand: 'Cinnamon Gold', item: 'Cinnamon Stick 100g', qty: 100, unit: 'g', price: 180, yield: 96, current_stock: 600, min_stock: 200, status: 'Active', mat_barcode: '8850123456814', name: 'Cinnamon Gold Cinnamon Stick 100g', unit_price: 1.875 },
      { id: 'MAT027', category: 'Packaging', brand: 'SealPro', item: 'Cup Sleeves 1000pcs', qty: 1000, unit: 'pcs', price: 85, yield: 100, current_stock: 1500, min_stock: 300, status: 'Active', mat_barcode: '8850123456815', name: 'SealPro Cup Sleeves 1000pcs', unit_price: 0.085 },
      { id: 'MAT028', category: 'Beans', brand: 'Colombian Geisha', item: 'Beans 100g', qty: 100, unit: 'g', price: 400, yield: 91, current_stock: 800, min_stock: 300, status: 'Active', mat_barcode: '8850123456816', name: 'Colombian Geisha Beans 100g', unit_price: 4.396 },
      { id: 'MAT029', category: 'Dairy', brand: 'Coconut Rich', item: 'Coconut Milk 500ml', qty: 500, unit: 'ml', price: 55, yield: 100, current_stock: 3500, min_stock: 800, status: 'Active', mat_barcode: '8850123456817', name: 'Coconut Rich Coconut Milk 500ml', unit_price: 0.11 },
      { id: 'MAT030', category: 'Tea', brand: 'Jasmine Essence', item: 'Jasmine Tea 200g', qty: 200, unit: 'g', price: 160, yield: 95, current_stock: 1200, min_stock: 400, status: 'Active', mat_barcode: '8850123456818', name: 'Jasmine Essence Jasmine Tea 200g', unit_price: 0.842 },
      { id: 'MAT031', category: 'Powder', brand: 'Instant Coffee', item: 'Instant Coffee 250g', qty: 250, unit: 'g', price: 190, yield: 100, current_stock: 2000, min_stock: 500, status: 'Active', mat_barcode: '8850123456819', name: 'Instant Coffee Instant Coffee 250g', unit_price: 0.76 },
      { id: 'MAT032', category: 'Sweetener', brand: 'Agave Nectar', item: 'Agave Syrup 500ml', qty: 500, unit: 'ml', price: 110, yield: 100, current_stock: 1500, min_stock: 400, status: 'Active', mat_barcode: '8850123456820', name: 'Agave Nectar Agave Syrup 500ml', unit_price: 0.22 },
      { id: 'MAT033', category: 'Spices', brand: 'Star Anise', item: 'Star Anise 50g', qty: 50, unit: 'g', price: 95, yield: 94, current_stock: 400, min_stock: 150, status: 'Active', mat_barcode: '8850123456821', name: 'Star Anise Star Anise 50g', unit_price: 2.021 },
      { id: 'MAT034', category: 'Packaging', brand: 'Napkins Plus', item: 'Napkins 500pcs', qty: 500, unit: 'pcs', price: 45, yield: 100, current_stock: 2000, min_stock: 400, status: 'Active', mat_barcode: '8850123456822', name: 'Napkins Plus Napkins 500pcs', unit_price: 0.09 },
      { id: 'MAT035', category: 'Beans', brand: 'Panama Geisha', item: 'Premium Blend 500g', qty: 500, unit: 'g', price: 550, yield: 92, current_stock: 600, min_stock: 200, status: 'Active', mat_barcode: '8850123456823', name: 'Panama Geisha Premium Blend 500g', unit_price: 1.195 }
    ];
    for (const m of materials) await insertRow('materials', m, client);

    const menus = [
      { id: 'MN001', name: 'Espresso', category: 'Coffee', front_price: 60, delivery_price: 75, status: 'Active' },
      { id: 'MN002', name: 'Latte', category: 'Coffee', front_price: 70, delivery_price: 85, status: 'Active' },
      { id: 'MN003', name: 'Iced Cocoa', category: 'Cocoa', front_price: 65, delivery_price: 80, status: 'Active' }
    ];
    for (const m of menus) await insertRow('menuname', m, client);

    await insertRow('packagingbom', {
      id: 'PBOM001', name: 'Standard 16oz Cold Cup Set',
      items: JSON.stringify([{ material_id: 'MAT005', qty_used: 1 }, { material_id: 'MAT006', qty_used: 1 }])
    }, client);

    const boms = [
      { menu_name: 'Espresso', material_id: 'MAT001', qty_used: 18 },
      { menu_name: 'Espresso', material_id: 'MAT004', qty_used: 10 },
      { menu_name: 'Espresso', material_id: 'PBOM001', qty_used: 1 },
      { menu_name: 'Latte', material_id: 'MAT001', qty_used: 18 },
      { menu_name: 'Latte', material_id: 'MAT002', qty_used: 150 },
      { menu_name: 'Latte', material_id: 'MAT004', qty_used: 10 },
      { menu_name: 'Latte', material_id: 'PBOM001', qty_used: 1 },
      { menu_name: 'Iced Cocoa', material_id: 'MAT003', qty_used: 20 },
      { menu_name: 'Iced Cocoa', material_id: 'MAT002', qty_used: 120 },
      { menu_name: 'Iced Cocoa', material_id: 'MAT004', qty_used: 25 },
      { menu_name: 'Iced Cocoa', material_id: 'PBOM001', qty_used: 1 }
    ];
    for (const b of boms) await insertRow('bom', b, client);

    const addons = [
      { name: 'Whipped Cream', price_change: 15 },
      { name: 'Caramel Drizzle', price_change: 10 },
      { name: 'Chocolate Chips', price_change: 12 }
    ];
    for (const a of addons) await insertRow('addons', a, client);

    await insertRow('promotions', {
      name: '10 Points = 1 Free Cup', type: 'points', status: 'Active',
      buy_qty: 10, free_qty: 1, max_free_value: 70
    }, client);

    const customers = [
      { name: 'John Doe', address: '123 Sukhumvit Rd, Bangkok', gender: 'M' },
      { name: 'Jane Smith', address: '456 Silom Rd, Bangkok', gender: 'F' },
      { name: 'Somsak Lee', address: '789 Sathorn Rd, Bangkok', gender: 'M' }
    ];
    for (const c of customers) await insertRow('customers', c, client);

    const salefronts = [
      { date: '2026-01-15', customer_name: 'John Doe', customer_address: '123 Sukhumvit Rd, Bangkok', menu_name: 'Espresso', quantity: 2, sweetness: '100%', container: 'Ice', addons: JSON.stringify(['Whipped Cream']), addon_price: 15, total_price: 150, cashier: 'admin' },
      { date: '2026-02-10', customer_name: 'Jane Smith', customer_address: '456 Silom Rd, Bangkok', menu_name: 'Latte', quantity: 1, sweetness: '50%', container: 'Ice', addons: JSON.stringify([]), addon_price: 0, total_price: 70, cashier: 'admin' },
      { date: '2026-03-05', customer_name: 'Somsak Lee', customer_address: '789 Sathorn Rd, Bangkok', menu_name: 'Iced Cocoa', quantity: 3, sweetness: '100%', container: 'Ice', addons: JSON.stringify([]), addon_price: 0, total_price: 195, cashier: 'staff' },
      { date: '2026-04-12', customer_name: 'John Doe', customer_address: '123 Sukhumvit Rd, Bangkok', menu_name: 'Latte', quantity: 4, sweetness: '25%', container: 'Hot', addons: JSON.stringify([]), addon_price: 0, total_price: 280, cashier: 'admin' },
      { date: '2026-05-20', customer_name: 'Somsak Lee', customer_address: '789 Sathorn Rd, Bangkok', menu_name: 'Espresso', quantity: 10, sweetness: '0%', container: 'Bottle', addons: JSON.stringify([]), addon_price: 0, total_price: 550, cashier: 'staff' },
      { date: '2026-06-01', customer_name: 'Jane Smith', customer_address: '456 Silom Rd, Bangkok', menu_name: 'Iced Cocoa', quantity: 2, sweetness: '50%', container: 'Ice', addons: JSON.stringify(['Chocolate Chips']), addon_price: 12, total_price: 154, cashier: 'admin' }
    ];
    for (const s of salefronts) await insertRow('salefront', s, client);

    const deliveries = [
      { date: '2026-01-20', customer_name: 'John Doe', customer_address: '123 Sukhumvit Rd, Bangkok', raw_order_string: 'Espresso (3), Latte (2)', base_price: 395, discount_tier1: '10%', discount_type1: 'percentage', discount_tier2: '', discount_type2: '', discount_tier3: '', discount_type3: '', ad_cost: 40, net_price: 315.5, status: 'Delivered', cashier: 'admin' },
      { date: '2026-02-18', customer_name: 'Jane Smith', customer_address: '456 Silom Rd, Bangkok', raw_order_string: 'Iced Cocoa (4)', base_price: 320, discount_tier1: 'WELCOME', discount_type1: 'code', discount_tier2: '', discount_type2: '', discount_tier3: '', discount_type3: '', ad_cost: 30, net_price: 250, status: 'Delivered', cashier: 'admin' },
      { date: '2026-03-22', customer_name: 'Somsak Lee', customer_address: '789 Sathorn Rd, Bangkok', raw_order_string: 'Latte (5)', base_price: 425, discount_tier1: '15', discount_type1: 'flat', discount_tier2: '5%', discount_type2: 'percentage', discount_tier3: '', discount_type3: '', ad_cost: 50, net_price: 339.5, status: 'Delivered', cashier: 'staff' },
      { date: '2026-04-28', customer_name: 'John Doe', customer_address: '123 Sukhumvit Rd, Bangkok', raw_order_string: 'Espresso (1), Iced Cocoa (2)', base_price: 235, discount_tier1: '', discount_type1: '', discount_tier2: '', discount_type2: '', discount_tier3: '', discount_type3: '', ad_cost: 25, net_price: 210, status: 'Delivered', cashier: 'admin' },
      { date: '2026-05-15', customer_name: 'Jane Smith', customer_address: '456 Silom Rd, Bangkok', raw_order_string: 'Latte (2)', base_price: 170, discount_tier1: '10%', discount_type1: 'percentage', discount_tier2: '', discount_type2: '', discount_tier3: '', discount_type3: '', ad_cost: 20, net_price: 133, status: 'Delivered', cashier: 'admin' },
      { date: '2026-06-05', customer_name: 'Somsak Lee', customer_address: '789 Sathorn Rd, Bangkok', raw_order_string: 'Espresso (4)', base_price: 300, discount_tier1: 'PROMO10', discount_type1: 'code', discount_tier2: '', discount_type2: '', discount_tier3: '', discount_type3: '', ad_cost: 30, net_price: 240, status: 'Pending', cashier: 'staff' }
    ];
    for (const d of deliveries) await insertRow('saledelivery', d, client);

    const expenses = [
      { date: '2026-01-02', description: 'Arabica Premium Beans 500g', amount: 1750, buyer: 'Admin', mat_barcode: '8850123456789', qty: 5, unit: 'g', price: 350, category: 'Beans', discount: 0, shipping_cost: 0, note: 'Initial stock setup' },
      { date: '2026-02-15', description: 'Meiji Milk 2L', amount: 950, buyer: 'Staff', mat_barcode: '8850123456790', qty: 10, unit: 'ml', price: 95, category: 'Dairy', discount: 0, shipping_cost: 0, note: 'Stock order' },
      { date: '2026-03-10', description: 'Rent Payment', amount: 12000, buyer: 'Admin', mat_barcode: '', qty: 1, unit: 'month', price: 12000, category: 'Rent', discount: 0, shipping_cost: 0, note: 'Monthly cafe rent' },
      { date: '2026-04-05', description: 'Mitr Phol Syrup 1L', amount: 480, buyer: 'Buyer A', mat_barcode: '8850123456792', qty: 8, unit: 'ml', price: 60, category: 'Sweetener', discount: 0, shipping_cost: 0, note: '' },
      { date: '2026-05-10', description: 'Van Houten Cocoa 500g', amount: 1120, buyer: 'Admin', mat_barcode: '8850123456791', qty: 4, unit: 'g', price: 280, category: 'Powder', discount: 0, shipping_cost: 0, note: '' },
      { date: '2026-06-02', description: 'Electric Bill', amount: 3450, buyer: 'Admin', mat_barcode: '', qty: 1, unit: 'pcs', price: 3450, category: 'Utility', discount: 0, shipping_cost: 0, note: '' }
    ];
    for (const e of expenses) await insertRow('expenses', e, client);
  });
}
