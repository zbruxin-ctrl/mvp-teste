import { AppState, AppStatus, Config, LogEntry } from '../types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type CycleExecutor = (config: Config, cycle: number) => Promise<void>;

// ─── KYC State ────────────────────────────────────────────────────────────────

export interface KycSignal {
  provider: 'Socure' | 'Veriff' | string;
  source: string;
  url?: string;
  weight: number;
  time: string;
  cycle: number;
}

export interface KycProviderState {
  score: number;
  level: 'WEAK' | 'LIKELY' | 'CONFIRMED';
  signals: KycSignal[];
}

function kycLevel(score: number): KycProviderState['level'] {
  if (score >= 8) return 'CONFIRMED';
  if (score >= 4) return 'LIKELY';
  return 'WEAK';
}

// ─── GlobalState ──────────────────────────────────────────────────────────────

class GlobalState {
  private state: AppState = {
    isRunning: false,
    isLoop: false,
    cyclesCompleted: 0,
    cyclesTotal: 0,
    status: 'STOPPED',
    config: {
      cadastroUrl: '',
      tempMailApiKey: '',
      otpTimeout: 30000,
      cycleInterval: 60000,
      extraDelay: 2000,
      headless: true,
    },
    shouldStop: false,
  };

  private logs: LogEntry[] = [];
  private currentCycle = 0;
  private executor: CycleExecutor | null = null;

  // KYC
  private kycProviders: Record<string, KycProviderState> = {};

  // ─── KYC API ────────────────────────────────────────────────────────────────

  addKycSignal(provider: string, source: string, weight: number, cycle: number, url?: string): void {
    if (!this.kycProviders[provider]) {
      this.kycProviders[provider] = { score: 0, level: 'WEAK', signals: [] };
    }
    const p = this.kycProviders[provider]!;
    p.score += weight;
    p.level = kycLevel(p.score);
    const signal: KycSignal = {
      provider,
      source,
      weight,
      cycle,
      url: url?.substring(0, 120),
      time: new Date().toLocaleTimeString('pt-BR'),
    };
    p.signals.unshift(signal);
    if (p.signals.length > 20) p.signals = p.signals.slice(0, 20);

    // Também aparece nos logs normais
    this.addLog('warn', `🔍 KYC [${provider}] score=${p.score} (${p.level}) via ${source}`, cycle);
  }

  getKycState(): Record<string, KycProviderState> {
    return { ...this.kycProviders };
  }

  clearKycState(): void {
    this.kycProviders = {};
  }

  // ─── Core API ───────────────────────────────────────────────────────────────

  setExecutor(fn: CycleExecutor): void {
    this.executor = fn;
  }

  getState(): AppState {
    return { ...this.state };
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }

  updateConfig(config: Partial<Config>): void {
    this.state.config = { ...this.state.config, ...config };
    this.addLog('info', 'Configuração atualizada');
  }

  addLog(level: LogEntry['level'], message: string, cycle?: number): void {
    this.logs.unshift({
      timestamp: new Date().toISOString(),
      level,
      message,
      cycle,
    });
    if (this.logs.length > 200) this.logs = this.logs.slice(0, 200);
  }

  stop(): void {
    if (this.state.status === 'RUNNING' || this.state.status === 'WAITING_OTP') {
      this.state.shouldStop = true;
      this.state.isLoop = false;
      this.state.status = 'STOPPING';
      this.addLog('warn', '🛑 Parando após ciclo atual...', this.currentCycle);
    } else {
      this.state.isRunning = false;
      this.state.isLoop = false;
      this.state.shouldStop = true;
      this.state.status = 'STOPPED';
      this.addLog('info', '⏹️ Processo parado', this.currentCycle);
    }
  }

  async startLoop(): Promise<void> {
    if (this.state.isRunning) { this.addLog('warn', '⚠️ Já está rodando'); return; }
    this.state.isLoop = true;
    this.state.shouldStop = false;
    this.state.status = 'STARTING';
    this.addLog('info', '🔄 Loop iniciado', 0);
    await this.runLoop(true);
  }

  async startOnce(): Promise<void> {
    if (this.state.isRunning) { this.addLog('warn', '⚠️ Já está rodando'); return; }
    this.state.isLoop = false;
    this.state.shouldStop = false;
    this.state.status = 'STARTING';
    this.addLog('info', '▶️ Ciclo único iniciado', 0);
    await this.runLoop(false);
  }

  private async runLoop(loop: boolean): Promise<void> {
    do {
      await this.executeCycleWithRetry();
      if (loop && !this.state.shouldStop) {
        this.addLog('info', `⏳ Aguardando ${Math.round(this.state.config.cycleInterval / 1000)}s para próximo ciclo...`);
        await sleep(this.state.config.cycleInterval);
      }
    } while (loop && !this.state.shouldStop);
  }

  // ─── Retry automático (até 3 tentativas, backoff 5s / 15s) ─────────────────

  private async executeCycleWithRetry(): Promise<void> {
    const MAX_RETRIES = 3;
    const BACKOFF = [0, 5000, 15000]; // delay antes de cada tentativa

    this.currentCycle += 1;
    this.state.cyclesTotal += 1;
    this.state.status = 'RUNNING';
    this.state.isRunning = true;

    let lastError: string = 'Erro desconhecido';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.state.shouldStop) break;

      const backoff = BACKOFF[attempt - 1] ?? 15000;
      if (backoff > 0) {
        this.addLog('warn', `⏳ Retry #${attempt} em ${backoff / 1000}s...`, this.currentCycle);
        await sleep(backoff);
      }

      try {
        this.addLog(
          'info',
          attempt === 1
            ? `🚀 Iniciando ciclo #${this.currentCycle}`
            : `🔁 Ciclo #${this.currentCycle} — tentativa ${attempt}/${MAX_RETRIES}`,
          this.currentCycle
        );

        if (!this.executor) throw new Error('Nenhum executor registrado.');

        await this.executor(this.state.config, this.currentCycle);

        // Sucesso!
        this.state.cyclesCompleted += 1;
        this.addLog('success', `✅ Ciclo #${this.currentCycle} concluído!`, this.currentCycle);
        this.state.isRunning = false;
        if (!this.state.isLoop || this.state.shouldStop) {
          this.state.status = 'STOPPED';
          this.state.shouldStop = false;
          this.addLog('info', '⏹️ Processo finalizado', this.currentCycle);
        }
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Erro desconhecido';
        this.addLog(
          'error',
          `❌ Tentativa ${attempt}/${MAX_RETRIES} falhou: ${lastError}`,
          this.currentCycle
        );
        await sleep(2000);
      }
    }

    // Todas as tentativas falharam
    this.state.status = 'ERROR';
    this.state.lastError = lastError;
    this.addLog('error', `💀 Ciclo #${this.currentCycle} falhou após ${MAX_RETRIES} tentativas: ${lastError}`, this.currentCycle);
    this.state.isRunning = false;
    if (!this.state.isLoop || this.state.shouldStop) {
      this.state.status = 'STOPPED';
      this.state.shouldStop = false;
      this.addLog('info', '⏹️ Processo finalizado', this.currentCycle);
    }
  }
}

export const globalState = new GlobalState();
