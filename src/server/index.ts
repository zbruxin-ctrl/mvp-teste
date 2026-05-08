import express from 'express';
import cors from 'cors';
import path from 'path';
import { globalState } from '../state/globalState';
import { TempMailClient } from '../tempMail/client';
import { ArtifactsManager } from '../utils/artifacts';
import { gerarPayloadCompleto, gerarPayloads } from '../utils/dataGenerators';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

ArtifactsManager.init();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'dist/frontend')));

// ── Status & Logs ──────────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => res.json(globalState.getState()));
app.get('/api/logs', (_req, res) => res.json(globalState.getLogs()));
app.post('/api/logs/clear', (_req, res) => { globalState.clearLogs(); res.json({ success: true }); });

// ── Config ─────────────────────────────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  globalState.updateConfig(req.body || {});
  res.json({ success: true });
});

// ── Controles ──────────────────────────────────────────────────────────────────
app.post('/api/start', async (req, res) => {
  try {
    if (req.body?.config) globalState.updateConfig(req.body.config);
    globalState.startLoop().catch((e) => globalState.addLog('error', String(e)));
    res.json({ success: true, message: 'Loop iniciado' });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.post('/api/start-once', async (req, res) => {
  try {
    if (req.body?.config) globalState.updateConfig(req.body.config);
    globalState.startOnce().catch((e) => globalState.addLog('error', String(e)));
    res.json({ success: true, message: 'Ciclo único iniciado' });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.post('/api/stop', (_req, res) => {
  globalState.stop();
  res.json({ success: true, message: 'Parado' });
});

// ── Temp-Mail testes ───────────────────────────────────────────────────────────
app.post('/api/temp-mail/test-create', async (req, res) => {
  try {
    const client = new TempMailClient(req.body.apiKey);
    const email = await client.createRandomEmail();
    res.json({ success: true, email });
  } catch (e) {
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/temp-mail/test-list', async (req, res) => {
  try {
    const client = new TempMailClient(req.body.apiKey);
    const messages = await client.listMessages(req.body.emailMd5);
    res.json({ success: true, messages });
  } catch (e) {
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/temp-mail/domains', async (req, res) => {
  try {
    const client = new TempMailClient(String(req.query.apiKey || ''));
    const domains = await client.getAvailableDomains();
    res.json({ success: true, domains });
  } catch (e) {
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/temp-mail/test-otp', async (req, res) => {
  try {
    const client = new TempMailClient(req.body.apiKey);
    const result = await client.createEmailAndWaitOTP(req.body.timeout || 30000);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Gerador ────────────────────────────────────────────────────────────────────
app.get('/api/generator/test', (req, res) => {
  const count = Math.min(parseInt(String(req.query.count ?? '1'), 10) || 1, 10);
  res.json({ success: true, payloads: gerarPayloads(count) });
});

app.post('/api/generator/payload', (req, res) => {
  res.json({ success: true, payload: gerarPayloadCompleto(req.body?.emailAccount) });
});

// ── Frontend fallback ──────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'dist/frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
