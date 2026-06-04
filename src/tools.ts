import { pool } from './db';

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

// ─── Tool: query_transactions ───────────────────────────────────────────────
// Handles complex transaction queries: net amounts, type filters, date ranges,
// fund aliases, refund/reversal subtraction
export async function queryTransactions(params: {
  fund_id?: string;
  fund_name?: string;
  txn_type?: string | string[];
  from_date?: string;
  to_date?: string;
  folio_no?: string;
  aggregate?: 'sum_amount' | 'sum_units' | 'count' | 'net_amount';
}): Promise<ToolResult> {
  try {
    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    // Fund filter: support partial name matching
    if (params.fund_id) {
      conditions.push(`t.fund_id = $${idx++}`);
      values.push(params.fund_id);
    } else if (params.fund_name) {
      conditions.push(`(f.fund_name ILIKE $${idx} OR t.fund_id ILIKE $${idx})`);
      values.push(`%${params.fund_name}%`);
      idx++;
    }

    // Transaction type filter (supports arrays)
    if (params.txn_type) {
      const types = Array.isArray(params.txn_type) ? params.txn_type : [params.txn_type];
      conditions.push(`t.txn_type = ANY($${idx++})`);
      values.push(types);
    }

    // Date range
    if (params.from_date) {
      conditions.push(`t.txn_date >= $${idx++}`);
      values.push(params.from_date);
    }
    if (params.to_date) {
      conditions.push(`t.txn_date <= $${idx++}`);
      values.push(params.to_date);
    }

    // Folio filter
    if (params.folio_no) {
      conditions.push(`t.folio_no = $${idx++}`);
      values.push(params.folio_no);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let query: string;

    if (params.aggregate === 'net_amount') {
      // Net = BUY - SELL (reversals subtract from total)
      query = `
        SELECT 
          t.fund_id,
          f.fund_name,
          SUM(CASE WHEN t.txn_type IN ('BUY','DIVIDEND') THEN t.amount 
                   WHEN t.txn_type = 'SELL' THEN -t.amount 
                   ELSE 0 END) AS net_amount,
          SUM(CASE WHEN t.txn_type = 'BUY' THEN t.units 
                   WHEN t.txn_type = 'SELL' THEN -t.units 
                   ELSE 0 END) AS net_units,
          COUNT(*) AS txn_count
        FROM transactions t
        LEFT JOIN funds f ON t.fund_id = f.fund_id
        ${whereClause}
        GROUP BY t.fund_id, f.fund_name
        ORDER BY net_amount DESC
      `;
    } else if (params.aggregate === 'sum_amount') {
      query = `
        SELECT 
          t.fund_id, f.fund_name,
          SUM(t.amount) AS total_amount,
          COUNT(*) AS txn_count
        FROM transactions t
        LEFT JOIN funds f ON t.fund_id = f.fund_id
        ${whereClause}
        GROUP BY t.fund_id, f.fund_name
        ORDER BY total_amount DESC
      `;
    } else if (params.aggregate === 'sum_units') {
      query = `
        SELECT 
          t.fund_id, f.fund_name,
          SUM(t.units) AS total_units
        FROM transactions t
        LEFT JOIN funds f ON t.fund_id = f.fund_id
        ${whereClause}
        GROUP BY t.fund_id, f.fund_name
      `;
    } else if (params.aggregate === 'count') {
      query = `
        SELECT COUNT(*) AS txn_count
        FROM transactions t
        LEFT JOIN funds f ON t.fund_id = f.fund_id
        ${whereClause}
      `;
    } else {
      // Return raw rows
      query = `
        SELECT 
          t.txn_id, t.fund_id, f.fund_name, t.txn_type,
          t.units, t.nav, t.amount, t.txn_date, t.folio_no
        FROM transactions t
        LEFT JOIN funds f ON t.fund_id = f.fund_id
        ${whereClause}
        ORDER BY t.txn_date DESC
        LIMIT 100
      `;
    }

    const result = await pool.query(query, values);

    return {
      success: true,
      data: {
        rows: result.rows,
        row_count: result.rowCount,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Tool: portfolio_analysis ────────────────────────────────────────────────
// Pure SQL-backed math: current value, absolute returns, XIRR-ready data,
// fund period returns vs user holding returns
export async function portfolioAnalysis(params: {
  mode:
    | 'summary'           // full portfolio summary
    | 'holding_return'    // user's return based on their purchase price
    | 'fund_period_return' // fund NAV return over arbitrary window
    | 'allocation'        // category/asset allocation
    | 'fund_detail';      // single fund deep dive
  fund_id?: string;
  fund_name?: string;
  from_date?: string;
  to_date?: string;
}): Promise<ToolResult> {
  try {
    let query: string;
    const values: any[] = [];

    if (params.mode === 'summary') {
      query = `
        SELECT
          h.fund_id,
          h.fund_name,
          f.category,
          h.units,
          h.purchase_nav,
          h.purchase_date,
          f.current_nav,
          f.nav_date,
          ROUND((h.units * h.purchase_nav)::numeric, 2) AS invested_amount,
          ROUND((h.units * f.current_nav)::numeric, 2) AS current_value,
          ROUND(((h.units * f.current_nav) - (h.units * h.purchase_nav))::numeric, 2) AS absolute_gain,
          ROUND((((f.current_nav - h.purchase_nav) / h.purchase_nav) * 100)::numeric, 2) AS return_pct,
          f.expense_ratio,
          f.aum_cr,
          f.benchmark
        FROM holdings h
        LEFT JOIN funds f ON h.fund_id = f.fund_id
        ORDER BY current_value DESC
      `;
    } else if (params.mode === 'holding_return') {
      const fundCondition = params.fund_id
        ? `AND h.fund_id = $1`
        : params.fund_name
        ? `AND (f.fund_name ILIKE $1)`
        : '';
      if (params.fund_id) values.push(params.fund_id);
      else if (params.fund_name) values.push(`%${params.fund_name}%`);

      query = `
        SELECT
          h.fund_id,
          h.fund_name,
          h.units,
          h.purchase_nav,
          h.purchase_date,
          f.current_nav,
          f.nav_date,
          ROUND((h.units * h.purchase_nav)::numeric, 2) AS invested_amount,
          ROUND((h.units * f.current_nav)::numeric, 2) AS current_value,
          ROUND(((h.units * f.current_nav) - (h.units * h.purchase_nav))::numeric, 2) AS absolute_gain,
          ROUND((((f.current_nav - h.purchase_nav) / h.purchase_nav) * 100)::numeric, 2) AS return_pct,
          ROUND(
            (((f.current_nav - h.purchase_nav) / h.purchase_nav) * 100 /
             NULLIF(EXTRACT(EPOCH FROM (f.nav_date - h.purchase_date)) / (365.25 * 86400), 0))::numeric,
          2) AS annualized_return_pct
        FROM holdings h
        LEFT JOIN funds f ON h.fund_id = f.fund_id
        WHERE 1=1 ${fundCondition}
      `;
    } else if (params.mode === 'fund_period_return') {
      // Compare NAV at two points using transaction history
      // Returns the pure fund performance (not user specific)
      const fromDate = params.from_date || '2023-01-01';
      const toDate = params.to_date || 'now()';

      query = `
        WITH nav_start AS (
          SELECT DISTINCT ON (fund_id) fund_id, nav AS start_nav, txn_date AS start_date
          FROM transactions
          WHERE txn_date >= $1
          ORDER BY fund_id, txn_date ASC
        ),
        nav_end AS (
          SELECT DISTINCT ON (fund_id) fund_id, nav AS end_nav, txn_date AS end_date
          FROM transactions
          WHERE txn_date <= $2
          ORDER BY fund_id, txn_date DESC
        )
        SELECT
          f.fund_id,
          f.fund_name,
          f.category,
          ns.start_nav,
          ns.start_date,
          ne.end_nav,
          ne.end_date,
          ROUND(((ne.end_nav - ns.start_nav) / ns.start_nav * 100)::numeric, 2) AS period_return_pct
        FROM funds f
        JOIN nav_start ns ON f.fund_id = ns.fund_id
        JOIN nav_end ne ON f.fund_id = ne.fund_id
        WHERE ns.start_nav IS NOT NULL AND ne.end_nav IS NOT NULL
        ORDER BY period_return_pct DESC
      `;
      values.push(fromDate, toDate);
    } else if (params.mode === 'allocation') {
      query = `
        SELECT
          f.category,
          COUNT(h.fund_id) AS fund_count,
          ROUND(SUM(h.units * f.current_nav)::numeric, 2) AS total_value,
          ROUND(
            (SUM(h.units * f.current_nav) / SUM(SUM(h.units * f.current_nav)) OVER () * 100)::numeric,
          2) AS allocation_pct
        FROM holdings h
        LEFT JOIN funds f ON h.fund_id = f.fund_id
        GROUP BY f.category
        ORDER BY total_value DESC
      `;
    } else if (params.mode === 'fund_detail') {
      const fundCondition = params.fund_id ? `h.fund_id = $1` : `f.fund_name ILIKE $1`;
      values.push(params.fund_id || `%${params.fund_name}%`);

      query = `
        SELECT
          h.fund_id,
          h.fund_name,
          f.category,
          f.amc,
          f.fund_manager,
          f.benchmark,
          f.expense_ratio,
          f.aum_cr,
          h.units,
          h.purchase_nav,
          h.purchase_date,
          f.current_nav,
          f.nav_date,
          ROUND((h.units * h.purchase_nav)::numeric, 2) AS invested_amount,
          ROUND((h.units * f.current_nav)::numeric, 2) AS current_value,
          ROUND(((h.units * f.current_nav) - (h.units * h.purchase_nav))::numeric, 2) AS absolute_gain,
          ROUND((((f.current_nav - h.purchase_nav) / h.purchase_nav) * 100)::numeric, 2) AS return_pct
        FROM holdings h
        LEFT JOIN funds f ON h.fund_id = f.fund_id
        WHERE ${fundCondition}
      `;
    } else {
      return { success: false, error: `Unknown mode: ${params.mode}` };
    }

    const result = await pool.query(query, values);
    return {
      success: true,
      data: { rows: result.rows, row_count: result.rowCount },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Tool Definitions (Ollama-compatible JSON Schema) ───────────────────────
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'query_transactions',
      description:
        'Query and aggregate mutual fund transactions from the database. Handles BUY, SELL, DIVIDEND types. Supports net calculations (BUY minus SELL), date ranges, and fund filtering. Never does arithmetic — all math is SQL-driven.',
      parameters: {
        type: 'object',
        properties: {
          fund_id: { type: 'string', description: 'Exact fund ID e.g. fund_bluechip' },
          fund_name: { type: 'string', description: 'Partial fund name for fuzzy matching' },
          txn_type: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Transaction type: BUY, SELL, DIVIDEND, or array of types',
          },
          from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
          to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
          aggregate: {
            type: 'string',
            enum: ['sum_amount', 'sum_units', 'count', 'net_amount'],
            description: 'Aggregation mode. net_amount = BUY - SELL for true invested figure.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'portfolio_analysis',
      description:
        'Analyze mutual fund portfolio holdings. Computes current values, gains, returns, and allocations using SQL — not LLM arithmetic. Differentiates between fund period return (NAV-based) and user holding return (purchase-price-based).',
      parameters: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: {
            type: 'string',
            enum: ['summary', 'holding_return', 'fund_period_return', 'allocation', 'fund_detail'],
            description:
              'Analysis mode: summary=full portfolio, holding_return=user gains, fund_period_return=NAV performance over window, allocation=category breakdown, fund_detail=single fund',
          },
          fund_id: { type: 'string', description: 'Exact fund ID' },
          fund_name: { type: 'string', description: 'Partial fund name' },
          from_date: { type: 'string', description: 'Period start YYYY-MM-DD' },
          to_date: { type: 'string', description: 'Period end YYYY-MM-DD' },
        },
      },
    },
  },
];
