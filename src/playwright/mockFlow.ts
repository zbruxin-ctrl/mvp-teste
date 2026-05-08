import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { globalState } from '../state/globalState';
import { TempMailClient } from '../tempMail/client';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

export class MockPlaywrightFlow {
  static async init(headless: boolean = true): Promise<void> {
    if (browser) return; // Proteção single runner
    
    globalState.addLog('info', `🌐 Playwright: ${headless ? 'headless' : 'headed'} mode`);
    
    browser = await chromium.launch({ 
      headless,
      slowMo: 100 // Delay visual
    });
    
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    
    page = await context.newPage();
  }

  static async execute(cadastroUrl: string, config: any, cycle: number): Promise<void> {
    if (!page) throw new Error('Playwright não inicializado');
    
    const client = new TempMailClient(config.tempMailApiKey);
    let retries = 0;
    const maxRetries = 2;

    try {
      // 1. Navegar
      await this.safeClick(page, cadastroUrl, 'Abrindo página', cycle);
      
      // 2. Email
      const emailResult = await client.createRandomEmail();
      const payload = gerarPayloadCompleto(emailResult);
      
      globalState.addLog('info', `👤 ${payload.nome} ${payload.sobrenome}`, cycle);
      await this.typeSafe(page, '[data-testid="email"]', payload.email, 'Preenchendo email', cycle);
      
      // 3. OTP Flow
      globalState.state.status = 'WAITING_OTP';
      const otp = await client.waitForOTP(emailResult.md5, config.otpTimeout);
      await this.typeSafe(page, '[data-testid="otp"]', otp, `Preenchendo OTP: ${otp}`, cycle);
      
      // 4. Restante form
      const steps: [string, string][] = [
        ['[data-testid="phone"]', payload.telefone],
        ['[data-testid="password"]', payload.senha],
        ['[data-testid="name"]', `${payload.nome} ${payload.sobrenome}`],
        ['[data-testid="location"]', payload.localizacao],
        ['[data-testid="refcode"]', payload.codigoIndicacao]
      ];

      for (const [selector, value] of steps) {
        await this.typeSafe(page, selector, value, `Preenchendo ${selector}`, cycle);
      }

      // 5. Checkboxes e submit
      await this.clickSafe(page, '[data-testid="concordo"]', 'Marcando Concordo', cycle);
      await this.clickSafe(page, '[data-testid="nao-ativar"]', 'Não ativar', cycle);
      await this.clickSafe(page, '[data-testid="foto-perfil"]', 'Foto de perfil', cycle);
      
      globalState.addLog('success', `🎉 Ciclo #${cycle} COMPLETO!`, cycle);
      
    } catch (error) {
      retries++;
      globalState.addLog('error', `💥 Ciclo #${cycle} falhou (${retries}/${maxRetries}): ${error}`, cycle);
      
      if (retries <= maxRetries) {
        await ArtifactsManager.saveScreenshot(page!, cycle, `retry-${retries}`);
        await this.sleep(3000);
      } else {
        await ArtifactsManager.saveScreenshot(page!, cycle, 'final-error');
        await ArtifactsManager.saveHTML(page!, cycle, 'final-error');
        throw error;
      }
    }
  }

  static async cleanup(): Promise<void> {
    if (page) {
      await page.close().catch(() => {});
      page = null;
    }
    if (context) {
      await context.close().catch(() => {});
      context = null;
    }
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    globalState.addLog('info', '🧹 Playwright fechado');
  }

  private static async safeClick(page: Page, urlOrSelector: string, step: string, cycle: number): Promise<void> {
    try {
      if (urlOrSelector.startsWith('http')) {
        await page.goto(urlOrSelector, { waitUntil: 'networkidle', timeout: 30000 });
      } else {
        await page.waitForSelector(urlOrSelector, { timeout: 10000 });
        await page.click(urlOrSelector);
      }
      globalState.addLog('info', `✅ ${step}`, cycle);
    } catch (e) {
      await ArtifactsManager.saveScreenshot(page, cycle, step);
      throw new Error(`${step}: ${e}`);
    }
  }

  private static async typeSafe(page: Page, selector: string, value: string, step: string, cycle: number): Promise<void> {
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.fill(selector, value);
      await page.waitForTimeout(1000); // Wait visual
      globalState.addLog('info', `✅ ${step}`, cycle);
    } catch (e) {
      await ArtifactsManager.saveScreenshot(page, cycle, step);
      throw new Error(`${step}: ${e}`);
    }
  }

  private static async clickSafe(page: Page, selector: string, step: string, cycle: number): Promise<void> {
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector);
      globalState.addLog('info', `✅ ${step}`, cycle);
    } catch (e) {
      await ArtifactsManager.saveScreenshot(page, cycle, step);
      throw new Error(`${step}: ${e}`);
    }
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// AJUSTAR ESTES SELECTORS para site real:
const steps: [string, string][] = [
  ['SEU_SELECTOR_EMAIL', payload.email],     // ex: 'input[name="email"]'
  ['SEU_SELECTOR_OTP', otp],                // ex: '#otp-input'
  ['SEU_SELECTOR_PHONE', payload.telefone], // ex: 'input#phone'
  // ...
];