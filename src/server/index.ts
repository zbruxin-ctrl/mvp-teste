import express from 'express';
import path from 'path';
import { globalState } from '../state/globalState';
import { MockPlaywrightFlow } from '../playwright/mockFlow';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../../src/frontend')));

// Registra o executor do Playwright — suporta parallelCycles
globalState.setExecutor(async (config, cycle) => {
  await MockPlaywrightFlow.init(config.headless);
  await MockPlaywrightFlow.execute(
    config.cadastroUrl,
    {
      tempMailApiKey: config.tempMailApiKey,
      otpTimeout: config.otpTimeout,
      extraDelay: config.extraDelay,
    },
    cycle
  );
});

// ─── Rotas API ────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  res.json(globalState.getState());
});

app.get('/api/logs', (_req, res) => {
  res.json(globalState.getLogs());
});

app.post('/api/logs/clear', (_req, res) => {
  globalState.clearLogs();
  res.json({ ok: true });
});

app.post('/api/config', (req, res) => {
  globalState.updateConfig(req.body);
  res.json({ ok: true });
});

app.post('/api/start', (req, res) => {
  if (req.body?.config) globalState.updateConfig(req.body.config);
  globalState.startLoop();
  res.json({ ok: true });
});

app.post('/api/start-once', (req, res) => {
  if (req.body?.config) globalState.updateConfig(req.body.config);
  globalState.startOnce();
  res.json({ ok: true });
});

app.post('/api/stop', (_req, res) => {
  globalState.stop();
  res.json({ ok: true });
});

// ─── Rota KYC ─────────────────────────────────────────────────────────────────

app.get('/api/kyc', (_req, res) => {
  res.json(globalState.getKycState());
});

app.post('/api/kyc/clear', (_req, res) => {
  globalState.clearKycState();
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Server rodando em http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  await MockPlaywrightFlow.cleanup();
  process.exit(0);
});
