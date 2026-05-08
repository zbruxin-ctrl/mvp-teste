// ... imports existentes ...

// Rota teste completa OTP
app.post('/api/temp-mail/test-otp', async (req, res) => {
  try {
    const { apiKey, timeout = 30000 } = req.body;
    const client = new TempMailClient(apiKey);
    
    const result = await client.createEmailAndWaitOTP(timeout);
    res.json({ 
      success: true, 
      email: result.email,
      md5: result.md5,
      otp: result.otp 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Erro desconhecido' 
    });
  }
});

// ... imports existentes ...
import { gerarPayloadCompleto, gerarPayloads } from '../utils/dataGenerators';

// Rota teste gerador de dados
app.get('/api/generator/test', (req, res) => {
  const count = parseInt(req.query.count as string) || 1;
  if (count > 10) {
    return res.status(400).json({ error: 'Máximo 10 payloads' });
  }
  
  const payloads = gerarPayloads(count);
  res.json({ success: true, payloads });
});

app.post('/api/generator/payload', (req, res) => {
  const { emailAccount } = req.body as { emailAccount?: any };
  const payload = gerarPayloadCompleto(emailAccount);
  res.json({ success: true, payload });
});

// REMOVER rotas de teste Temp-Mail e Generator (já integradas)
// Manter apenas APIs principais
import { MockPlaywrightFlow } from '../playwright/mockFlow';
import { ArtifactsManager } from '../utils/artifacts';

// Inicializar artifacts
ArtifactsManager.init();

// Start com Playwright
app.post('/api/start', async (req, res) => {
  const config = globalState.getState().config;
  await MockPlaywrightFlow.init(config.headless);
  
  globalState.startLoop().catch(console.error);
  res.json({ success: true });
});

// Cleanup no stop
app.post('/api/stop', async (req, res) => {
  globalState.stop();
  await MockPlaywrightFlow.cleanup();
  res.json({ success: true });
});

import express from 'express';
import cors from 'cors';
import path from 'path';
import { globalState } from '../state/globalState';
import { AppState } from '../types';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('dist/frontend'));

// Estado global
app.get('/api/status', (req, res) => {
  res.json(globalState.getState());
});

app.get('/api/logs', (req, res) => {
  res.json(globalState.getLogs());
});

// Controle
app.post('/api/start', (req, res) => {
  globalState.setRunning(true, true);
  res.json({ success: true, message: 'Loop iniciado' });
});

app.post('/api/start-once', (req, res) => {
  globalState.setRunning(true, false);
  res.json({ success: true, message: 'Ciclo único iniciado' });
});

app.post('/api/stop', (req, res) => {
  globalState.setRunning(false);
  res.json({ success: true, message: 'Parado' });
});

// Frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dist/frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📱 Frontend: http://localhost:${PORT}`);
});