import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext } from 'playwright';
import { globalState } from '../state/globalState';
import { TempMailClient } from '../tempMail/client';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';

// Ativa o stealth plugin — mascara sinais de automação (webdriver, plugins, etc)
chromiumExtra.use(StealthPlugin());

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

async function fillField(p: Page, selector: string, value: string, delay = 80): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await p.click(selector);
  await p.fill(selector, '');
  await p.type(selector, value, { delay });
}

async function clickBtn(p: Page, selector: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await p.click(selector);
}

export class MockPlaywrightFlow {
  static async init(headless = true): Promise<void> {
    if (browser) {
      globalState.addLog('info', '🌐 Reusando browser existente');
      page = await context!.newPage();
      return;
    }
    globalState.addLog('info', `🌐 Playwright iniciando (${headless ? 'headless' : 'headed'}) com stealth`);

    browser = await chromiumExtra.launch({
      headless,
      slowMo: 80,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1366,768',
      ],
    }) as unknown as Browser;

    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      geolocation: { latitude: -22.4306, longitude: -45.4528 },
      permissions: ['geolocation'],
      extraHTTPHeaders: {
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US'] });
      (window as any).chrome = { runtime: {} };
    });

    page = await context.newPage();
  }

  static async execute(
    cadastroUrl: string,
    config: {
      tempMailApiKey: string;
      otpTimeout: number;
      extraDelay: number;
    },
    cycle: number
  ): Promise<void> {
    if (!page) throw new Error('Playwright não inicializado');

    const client = new TempMailClient(config.tempMailApiKey);
    const p = page;

    try {
      // ── FASE 1: auth.uber.com ───────────────────────────────────────────────

      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      globalState.addLog('info', '🌐 Página aberta', cycle);

      const emailAccount = await client.createRandomEmail();
      const payload = gerarPayloadCompleto(emailAccount);
      globalState.addLog('info', `👤 ${payload.nome} ${payload.sobrenome} | ${payload.email}`, cycle);

      // Etapa 1 — email
      await fillField(p, '#PHONE_NUMBER_or_EMAIL_ADDRESS', payload.email, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '📧 Email preenchido → Continuar', cycle);

      // Etapa 2 — OTP (4 inputs separados)
      globalState.addLog('info', '⏳ Aguardando OTP...', cycle);
      const otp = await client.waitForOTP(emailAccount.md5, config.otpTimeout);
      globalState.addLog('info', `🔑 OTP recebido: ${otp}`, cycle);
      const digits = otp.replace(/\D/g, '').split('');
      for (let i = 0; i < digits.length; i++) {
        await fillField(p, `#EMAIL_OTP_CODE-${i}`, digits[i]!, 50);
      }
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '✅ OTP preenchido → Avançar', cycle);

      // Etapa 3 — telefone
      await fillField(p, '#PHONE_NUMBER', payload.telefone, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', `📱 Telefone: ${payload.telefone}`, cycle);

      // Etapa 4 — senha
      await fillField(p, '#PASSWORD', payload.senha, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '🔒 Senha preenchida', cycle);

      // Etapa 5 — nome e sobrenome
      await fillField(p, '#FIRST_NAME', payload.nome, 80);
      await fillField(p, '#LAST_NAME', payload.sobrenome, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', `👤 Nome: ${payload.nome} ${payload.sobrenome}`, cycle);

      // Etapa 6 — checkbox termos
      await p.waitForSelector('input[type="checkbox"]', { state: 'visible', timeout: 10000 });
      const checkbox = p.locator('input[type="checkbox"]').first();
      if (!(await checkbox.isChecked())) await checkbox.check();
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '☑️ Termos aceitos', cycle);

      // ── FASE 2: bonjour.uber.com (após redirect automático) ──────────────────
      await p.waitForURL('**/bonjour.uber.com/**', { timeout: 20000 });
      globalState.addLog('info', '🔄 Redirecionado para bonjour.uber.com', cycle);

      // Etapa bonjour/1 — cidade + código convite
      await fillField(p, '[data-testid="flow-type-city-selector-v2-input"]', payload.localizacao, 80);
      await p.waitForTimeout(1200);
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('Enter');
      await p.waitForTimeout(500);
      await fillField(p, '[data-testid="signup-step::invite-code-input"]', payload.codigoIndicacao, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '[data-testid="submit-button"]');
      globalState.addLog('info', `📍 Cidade: ${payload.localizacao} | Convite: ${payload.codigoIndicacao}`, cycle);

      // Etapa bonjour/2 — notificação
      await p.waitForTimeout(2000);
      const naoAtivar = p.locator('button:has-text("NÃO ATIVAR")');
      const continuar = p.locator('button:has-text("CONTINUAR")');
      if (await naoAtivar.isVisible().catch(() => false)) {
        await naoAtivar.click();
        globalState.addLog('info', '🔕 Notificações: NÃO ATIVAR', cycle);
      } else if (await continuar.isVisible().catch(() => false)) {
        await continuar.click();
        globalState.addLog('info', '▶️ Notificações: CONTINUAR', cycle);
      } else {
        globalState.addLog('warn', '⚠️ Botão de notificação não encontrado, continuando...', cycle);
      }

      await p.waitForTimeout(config.extraDelay);
      globalState.addLog('success', `🎉 Ciclo #${cycle} COMPLETO!`, cycle);

    } catch (error) {
      await ArtifactsManager.saveScreenshot(p, cycle, 'error').catch(() => {});
      await ArtifactsManager.saveHTML(p, cycle, 'error').catch(() => {});
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
    globalState.addLog('info', '🧹 Browser fechado manualmente');
  }
}
