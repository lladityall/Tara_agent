import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'sample_a',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'Aditya@136',
});

async function columnExists(client: any, table: string, column: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return (res.rowCount ?? 0) > 0;
}

async function tableExists(client: any, table: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return (res.rowCount ?? 0) > 0;
}

async function dropIfSchemaMismatch(client: any): Promise<void> {
  // Check if existing tables have the expected columns; drop if not
  const tables = ['transactions', 'holdings', 'funds'];
  const requiredColumns: Record<string, string> = {
    funds: 'fund_id',
    holdings: 'fund_id',
    transactions: 'txn_id',
  };

  let needsDrop = false;
  for (const tbl of tables) {
    if (await tableExists(client, tbl)) {
      const col = requiredColumns[tbl];
      if (!(await columnExists(client, tbl, col))) {
        console.log(`⚠  Table "${tbl}" exists but missing column "${col}" — will recreate`);
        needsDrop = true;
      }
    }
  }

  if (needsDrop) {
    console.log('🗑  Dropping mismatched tables...');
    // Drop in FK-safe order
    await client.query(`DROP TABLE IF EXISTS transactions CASCADE`);
    await client.query(`DROP TABLE IF EXISTS holdings CASCADE`);
    await client.query(`DROP TABLE IF EXISTS funds CASCADE`);
    console.log('✓ Old tables dropped');
  }
}

async function createTables(client: any): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS funds (
      fund_id       VARCHAR(100) PRIMARY KEY,
      fund_name     VARCHAR(255) NOT NULL,
      category      VARCHAR(100),
      amc           VARCHAR(255),
      current_nav   NUMERIC(12,4),
      nav_date      DATE,
      expense_ratio NUMERIC(5,4),
      aum_cr        NUMERIC(15,2),
      fund_manager  VARCHAR(255),
      benchmark     VARCHAR(255),
      launch_date   DATE,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✓ funds table ready');

  await client.query(`
    CREATE TABLE IF NOT EXISTS holdings (
      id            SERIAL PRIMARY KEY,
      fund_id       VARCHAR(100) REFERENCES funds(fund_id),
      fund_name     VARCHAR(255),
      units         NUMERIC(12,4) NOT NULL,
      purchase_date DATE,
      purchase_nav  NUMERIC(12,4),
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✓ holdings table ready');

  await client.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      txn_id     VARCHAR(100) PRIMARY KEY,
      fund_id    VARCHAR(100) REFERENCES funds(fund_id),
      txn_type   VARCHAR(50) NOT NULL,
      units      NUMERIC(12,4),
      nav        NUMERIC(12,4),
      amount     NUMERIC(15,2),
      txn_date   DATE,
      folio_no   VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✓ transactions table ready');

  // Create indexes — check pg_indexes first to avoid duplicate errors
  const indexes: Array<{ name: string; ddl: string }> = [
    { name: 'idx_holdings_fund_id',      ddl: 'CREATE INDEX idx_holdings_fund_id ON holdings(fund_id)' },
    { name: 'idx_transactions_fund_id',  ddl: 'CREATE INDEX idx_transactions_fund_id ON transactions(fund_id)' },
    { name: 'idx_transactions_txn_date', ddl: 'CREATE INDEX idx_transactions_txn_date ON transactions(txn_date)' },
    { name: 'idx_transactions_txn_type', ddl: 'CREATE INDEX idx_transactions_txn_type ON transactions(txn_type)' },
  ];

  for (const idx of indexes) {
    const res = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
      [idx.name]
    );
    if ((res.rowCount ?? 0) === 0) {
      await client.query(idx.ddl);
    }
  }
  console.log('✓ indexes ready');
}

async function ingestJSON(client: any, tableName: string, filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    console.log(`⚠  File not found: ${filePath}, skipping...`);
    return;
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) {
    console.log(`⚠  No data in ${filePath}, skipping...`);
    return;
  }

  const keys = Object.keys(data[0]);
  const cols = keys.map(k => `"${k}"`).join(', ');
  let inserted = 0, skipped = 0;

  for (const row of data) {
    const vals = keys.map(k => (row[k] === undefined ? null : row[k]));
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    try {
      await client.query(
        `INSERT INTO ${tableName} (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        vals
      );
      inserted++;
    } catch (err: any) {
      console.error(`  ✗ Row error in ${tableName}:`, err.message);
      skipped++;
    }
  }

  console.log(`✓ ${tableName}: ${inserted} inserted, ${skipped} skipped`);
}

export async function runIngestion(): Promise<void> {
  const client = await pool.connect();
  const dataDir = path.join(__dirname, '..', 'data');

  try {
    // Step 1: check for schema mismatches outside the main transaction
    await dropIfSchemaMismatch(client);

    // Step 2: create + ingest atomically
    await client.query('BEGIN');
    console.log('\n🔧 Creating/verifying tables...');
    await createTables(client);

    console.log('\n📥 Ingesting data files...');
    await ingestJSON(client, 'funds',        path.join(dataDir, 'funds.json'));
    await ingestJSON(client, 'holdings',     path.join(dataDir, 'holdings.json'));
    await ingestJSON(client, 'transactions', path.join(dataDir, 'transactions.json'));

    await client.query('COMMIT');
    console.log('\n✅ Ingestion complete!\n');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Ingestion failed, rolled back:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runIngestion().catch(err => {
    console.error(err);
    process.exit(1);
  });
}