import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { globalState } from '../state/globalState';
import { TempMailClient } from '../tempMail/client';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

export class MockPlaywrightFlow {
  static async init(headless = true): Promise<void> {
    if (browser) return;
    globalState.addLog('info', `🌐 Playwright iniciando (${headless ? 'headless' : 'headed'})`);
    browser = await chromium.launch({ headless, slowMo: 100 });
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    page = await context.newPage();
  }

  static async execute(cadastroUrl: string, config: { tempMailApiKey: string; otpTimeout: number; extraDelay: number }, cycle: number): Promise<void> {
    if (!page) throw new Error('Playwright não inicializado');

    const client = new TempMailClient(config.tempMailApiKey);

    try {
      // 1. Abrir página
      await page.goto(cadastroUrl, { waitUntil: 'networkidle', timeout: 30000 });
      globalState.addLog('info', '🌐 Página aberta', cycle);

      // 2. Criar email
      const emailResult = await client.createRandomEmail();
      const payload = gerarPayloadCompleto(emailResult);
      globalState.addLog('info', `👤 ${payload.nome} ${payload.sobrenome} | ${payload.email}`, cycle);

      // 3. Preencher email
      await page.waitForSelector('[data-testid="email"]', { timeout: 10000 });
      await page.fill('[data-testid="email"]', payload.email);
      await page.waitForTimeout(config.extraDelay);

      // 4. Aguardar OTP
      globalState.addLog('info', '⏳ Aguardando OTP...', cycle);
      const otp = await client.waitForOTP(emailResult.md5, config.otpTimeout);

      // 5. Preencher OTP
      await page.waitForSelector('[data-testid="otp"]', { timeout: 10000 });
      await page.fill('[data-testid="otp"]', otp);
      await page.waitForTimeout(config.extraDelay);

      // 6. Demais campos
      const fields: Array<[string, string]> = [
        ['[data-testid="phone"]', payload.telefone],
        ['[data-testid="password"]', payload.senha],
        ['[data-testid="name"]', `${payload.nome} ${payload.sobrenome}`],
        ['[data-testid="refcode"]', payload.codigoIndicacao],
      ];
      for (const [selector, value] of fields) {
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.fill(selector, value);
        await page.waitForTimeout(config.extraDelay);
        globalState.addLog('info', `✅ Preenchido ${selector}`, cycle);
      }

      // 7. Localização (dropdown pesquisável)
      await page.waitForSelector('[data-testid="location"]', { timeout: 10000 });
      await page.fill('[data-testid="location"]', payload.localizacao);
      await page.waitForTimeout(1000);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');

      // 8. Checkboxes e finalização
      await page.click('[data-testid="concordo"]').catch(() => {});
      await page.waitForTimeout(500);
      await page.click('[data-testid="nao-ativar"]').catch(() => {});
      await page.waitForTimeout(500);
      await page.click('[data-testid="foto-perfil"]').catch(() => {});

      globalState.addLog('success', `🎉 Ciclo #${cycle} COMPLETO!`, cycle);
    } catch (error) {
      await ArtifactsManager.saveScreenshot(page!, cycle, 'error').catch(() => {});
      await ArtifactsManager.saveHTML(page!, cycle, 'error').catch(() => {});
      throw error;
    }
  }

  static async cleanup(): Promise<void> {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    page = null;
    context = null;
    browser = null;
    globalState.addLog('info', '🧹 Playwright fechado');
  }
}
