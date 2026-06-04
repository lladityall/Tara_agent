import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { askTara, AgentResponse } from './tara';
import { runIngestion } from './ingest';
import { pool } from './db';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

// In-memory request log for the dashboard
interface RequestLog {
  id: string;
  timestamp: string;
  question: string;
  status: 'pending' | 'success' | 'error';
  latency_ms?: number;
  trace_count?: number;
  answer_preview?: string;
}

const requestLogs: RequestLog[] = [];

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── POST /ask ────────────────────────────────────────────────────────────────
app.post('/ask', async (req: Request, res: Response) => {
  const { question } = req.body;

  if (!question || typeof question !== 'string' || question.trim() === '') {
    return res.status(400).json({ error: 'question field is required' });
  }

  const logId = uuidv4();
  const log: RequestLog = {
    id: logId,
    timestamp: new Date().toISOString(),
    question: question.trim(),
    status: 'pending',
  };
  requestLogs.unshift(log);

  try {
    const result: AgentResponse = await askTara(question.trim());

    log.status = 'success';
    log.latency_ms = result.total_latency_ms;
    log.trace_count = result.traces.length;
    log.answer_preview = result.answer.substring(0, 120);

    return res.json({
      id: logId,
      answer: result.answer,
      traces: result.traces,
      total_latency_ms: result.total_latency_ms,
    });
  } catch (err: any) {
    log.status = 'error';
    log.answer_preview = err.message;

    return res.status(500).json({
      id: logId,
      error: err.message,
    });
  }
});

// ─── GET /api/logs ────────────────────────────────────────────────────────────
app.get('/api/logs', (_req: Request, res: Response) => {
  res.json(requestLogs.slice(0, 50));
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
app.get('/api/stats', async (_req: Request, res: Response) => {
  try {
    const [fundsRes, holdingsRes, txnRes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM funds'),
      pool.query('SELECT COUNT(*) FROM holdings'),
      pool.query('SELECT COUNT(*) FROM transactions'),
    ]);

    const successCount = requestLogs.filter(l => l.status === 'success').length;
    const avgLatency =
      requestLogs.filter(l => l.latency_ms).reduce((sum, l) => sum + (l.latency_ms || 0), 0) /
      Math.max(successCount, 1);

    res.json({
      db: {
        funds: parseInt(fundsRes.rows[0].count),
        holdings: parseInt(holdingsRes.rows[0].count),
        transactions: parseInt(txnRes.rows[0].count),
      },
      requests: {
        total: requestLogs.length,
        success: successCount,
        error: requestLogs.filter(l => l.status === 'error').length,
        avg_latency_ms: Math.round(avgLatency),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ingest ─────────────────────────────────────────────────────────
app.post('/api/ingest', async (_req: Request, res: Response) => {
  try {
    await runIngestion();
    res.json({ success: true, message: 'Ingestion complete' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'disconnected' });
  }
});

// ─── Serve index.html for all other routes ────────────────────────────────────
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   TARA Financial Intelligence Engine   ║`);
  console.log(`║   Running on http://localhost:${PORT}      ║`);
  console.log(`╚════════════════════════════════════════╝\n`);
});

export default app;
