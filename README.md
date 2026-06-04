# Tara — Financial Intelligence Engine

Enterprise-grade mutual fund portfolio AI, powered by Ollama Cloud + PostgreSQL.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Tara System                             │
│                                                             │
│  ┌──────────┐    ┌──────────────┐    ┌────────────────┐    │
│  │ Express  │───▶│  tara.ts     │───▶│ Ollama Cloud   │    │
│  │ Server   │    │  Agent Core  │    │ gpt-oss:120b   │    │
│  └──────────┘    └──────┬───────┘    └────────────────┘    │
│       │                 │                                   │
│       │          ┌──────▼───────┐                          │
│       │          │   tools.ts   │                          │
│       │          │ ┌──────────┐ │                          │
│       │          │ │query_txn │ │                          │
│       │          │ └────┬─────┘ │                          │
│       │          │ ┌────▼─────┐ │                          │
│       │          │ │portfolio │ │                          │
│       │          │ │_analysis │ │                          │
│       │          │ └────┬─────┘ │                          │
│       │          └──────┼───────┘                          │
│       │                 │                                   │
│       │          ┌──────▼───────┐                          │
│       └─────────▶│  PostgreSQL  │                          │
│                  │  funds       │                          │
│                  │  holdings    │                          │
│                  │  transactions│                          │
│                  └──────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

**Key design principle:** The LLM never does math. All arithmetic is delegated to SQL via tools.

---

## Setup

### 1. Prerequisites

- Node.js 20+
- PostgreSQL running locally on port 5432
- Database `sample_a` created
- Ollama Cloud API key

### 2. Install

```bash
npm install
```

### 3. Configure

Edit `.env`:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=sample_a
DB_USER=postgres
DB_PASSWORD=Aditya@136
OLLAMA_API_KEY=your_key_here
PORT=3000
```

### 4. Prepare data

Place your JSON files in `/data/`:
- `data/funds.json`
- `data/holdings.json`
- `data/transactions.json`

### 5. Ingest data

```bash
npm run ingest
```

This will:
- Create tables if they don't exist (idempotent — safe to re-run)
- Load all JSON files with ON CONFLICT DO NOTHING (no duplicate insertion)
- Create all necessary indexes

### 6. Run

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

Open http://localhost:3000

---

## API

### POST /ask

```json
{
  "question": "What is my total portfolio value?"
}
```

Response:
```json
{
  "id": "uuid",
  "answer": "Your total portfolio value is ₹1,23,456.78...",
  "traces": [...],
  "total_latency_ms": 2340
}
```

### GET /api/logs

Returns last 50 request logs with status, latency, and trace counts.

### GET /api/stats

Returns DB record counts and session statistics.

### POST /api/ingest

Triggers a fresh data ingestion from the `/data/` folder.

### GET /health

Health check — returns DB connectivity status.

---

## Data Schema

### funds
| Column | Type | Description |
|--------|------|-------------|
| fund_id | VARCHAR PK | Unique fund identifier |
| fund_name | VARCHAR | Full fund name |
| category | VARCHAR | Equity/Debt/Gold/etc |
| current_nav | NUMERIC | Latest NAV |
| expense_ratio | NUMERIC | Annual fee % |

### holdings
| Column | Type | Description |
|--------|------|-------------|
| fund_id | FK | Reference to funds |
| units | NUMERIC | Units held |
| purchase_date | DATE | Entry date |
| purchase_nav | NUMERIC | Price paid per unit |

### transactions
| Column | Type | Description |
|--------|------|-------------|
| txn_id | VARCHAR PK | Unique transaction ID |
| fund_id | FK | Reference to funds |
| txn_type | VARCHAR | BUY / SELL / DIVIDEND |
| units | NUMERIC | Units transacted |
| nav | NUMERIC | NAV at transaction |
| amount | NUMERIC | Total amount |

---

## Tools

### `query_transactions`
SQL-backed transaction queries with:
- Fuzzy fund name matching (ILIKE wildcards)
- Net amount calculation (BUY − SELL)
- Date range filtering
- Multi-type aggregation

### `portfolio_analysis`
Five analysis modes:
| Mode | Description |
|------|-------------|
| `summary` | Full portfolio with current values and P&L |
| `holding_return` | User's return vs their purchase price |
| `fund_period_return` | NAV performance over arbitrary date window |
| `allocation` | Category/asset class breakdown |
| `fund_detail` | Deep dive on a single fund |
