import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { globalState } from '../state/globalState';
import { TempMailClient } from '../tempMail/client';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

// Helper: aguarda selector e preenche com delay humano
async function fillField(p: Page, selector: string, value: string, delay = 80): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await p.click(selector);
  await p.fill(selector, '');
  await p.type(selector, value, { delay });
}

// Helper: aguarda e clica
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
    globalState.addLog('info', `🌐 Playwright iniciando (${headless ? 'headless' : 'headed'})`);
    browser = await chromium.launch({ headless, slowMo: 80 });
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
      // ── FASE 1: auth.uber.com ─────────────────────────────────────────────

      // 1. Abrir página de login
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      globalState.addLog('info', '🌐 Página aberta', cycle);

      // 2. Criar email temporário e gerar payload
      const emailAccount = await client.createRandomEmail();
      const emailToken = (emailAccount as unknown as { token: string }).token;
      const payload = gerarPayloadCompleto(emailAccount);
      globalState.addLog('info', `👤 ${payload.nome} ${payload.sobrenome} | ${payload.email}`, cycle);

      // 3. Etapa 1 — preencher email e clicar Continuar
      // Seletor: input[type="email"]#PHONE_NUMBER_or_EMAIL_ADDRESS
      await fillField(p, '#PHONE_NUMBER_or_EMAIL_ADDRESS', payload.email, config.extraDelay > 1000 ? 80 : 50);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '📧 Email preenchido → Continuar', cycle);

      // 4. Etapa 2 — OTP por email (4 inputs separados: EMAIL_OTP_CODE-0 a -3)
      globalState.addLog('info', '⏳ Aguardando OTP...', cycle);
      const otp = await client.waitForOTP(emailToken, config.otpTimeout);
      globalState.addLog('info', `🔑 OTP recebido: ${otp}`, cycle);

      // OTP vem como string "1234" — preenche cada dígito num input separado
      const digits = otp.replace(/\D/g, '').split('');
      for (let i = 0; i < digits.length; i++) {
        await fillField(p, `#EMAIL_OTP_CODE-${i}`, digits[i]!, 50);
      }
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button[data-testid="forward-button"]');
      globalState.addLog('info', '✅ OTP preenchido → Avançar', cycle);

      // 5. Etapa 3 — telefone
      // Seletor: input#PHONE_NUMBER (placeholder: "(11) 96123-4567")
      await fillField(p, '#PHONE_NUMBER', payload.telefone, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', `📱 Telefone: ${payload.telefone}`, cycle);

      // 6. Etapa 4 — senha (email hidden já está preenchido pelo Uber)
      // Seletor: input#PASSWORD[type="password"]
      await fillField(p, '#PASSWORD', payload.senha, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '🔒 Senha preenchida', cycle);

      // 7. Etapa 5 — nome e sobrenome
      await fillField(p, '#FIRST_NAME', payload.nome, 80);
      await fillField(p, '#LAST_NAME', payload.sobrenome, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', `👤 Nome: ${payload.nome} ${payload.sobrenome}`, cycle);

      // 8. Etapa 6 — checkbox de termos
      // Seletor: input[type="checkbox"] (único checkbox visível)
      await p.waitForSelector('input[type="checkbox"]', { state: 'visible', timeout: 10000 });
      const checkbox = p.locator('input[type="checkbox"]').first();
      const isChecked = await checkbox.isChecked();
      if (!isChecked) await checkbox.check();
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '☑️ Termos aceitos', cycle);

      // ── FASE 2: bonjour.uber.com (após reload/redirect) ───────────────────
      // O browser vai redirecionar automaticamente para bonjour.uber.com
      // Aguarda a nova URL carregar
      await p.waitForURL('**/bonjour.uber.com/**', { timeout: 20000 });
      globalState.addLog('info', '🔄 Redirecionado para bonjour.uber.com', cycle);

      // 9. Etapa bonjour/1 — cidade + código de convite
      // Seletor: input[data-testid="flow-type-city-selector-v2-input"]
      await fillField(p, '[data-testid="flow-type-city-selector-v2-input"]', payload.localizacao, 80);
      // Aguarda dropdown e seleciona primeira opção
      await p.waitForTimeout(1200);
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('Enter');
      await p.waitForTimeout(500);

      // Código de convite
      await fillField(p, '[data-testid="signup-step::invite-code-input"]', payload.codigoIndicacao, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '[data-testid="submit-button"]');
      globalState.addLog('info', `📍 Cidade: ${payload.localizacao} | Convite: ${payload.codigoIndicacao}`, cycle);

      // 10. Etapa bonjour/2 — permissão de notificação (NÃO ATIVAR ou CONTINUAR)
      // Aguarda aparecer um dos dois botões
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

  /** Fechamento manual completo — chamado via POST /api/cleanup */
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
