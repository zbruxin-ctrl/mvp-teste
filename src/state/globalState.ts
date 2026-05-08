import { AppState, AppStatus, Config, LogEntry } from '../types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    if (
      this.state.status === 'RUNNING' ||
      this.state.status === 'WAITING_OTP'
    ) {
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
    this.state.isLoop = true;
    this.state.shouldStop = false;
    this.state.status = 'STARTING';
    this.addLog('info', '🔄 Loop iniciado', 0);
    await this.runLoop(true);
  }

  async startOnce(): Promise<void> {
    this.state.isLoop = false;
    this.state.shouldStop = false;
    this.state.status = 'STARTING';
    this.addLog('info', '▶️ Ciclo único iniciado', 0);
    await this.runLoop(false);
  }

  private async runLoop(loop: boolean): Promise<void> {
    do {
      await this.executeCycle();
      if (loop && !this.state.shouldStop) {
        this.addLog(
          'info',
          `⏳ Aguardando ${Math.round(this.state.config.cycleInterval / 1000)}s...`
        );
        await sleep(this.state.config.cycleInterval);
      }
    } while (loop && !this.state.shouldStop);
  }

  private async executeCycle(): Promise<void> {
    this.currentCycle += 1;
    this.state.cyclesTotal += 1;
    this.state.status = 'RUNNING';
    this.state.isRunning = true;

    try {
      this.addLog('info', `🚀 Iniciando ciclo #${this.currentCycle}`, this.currentCycle);
      await this.mockPipeline();
      this.state.cyclesCompleted += 1;
      this.addLog('success', `✅ Ciclo #${this.currentCycle} concluído!`, this.currentCycle);
    } catch (error) {
      this.state.status = 'ERROR';
      this.state.lastError =
        error instanceof Error ? error.message : 'Erro desconhecido';
      this.addLog('error', `❌ Falha #${this.currentCycle}: ${this.state.lastError}`, this.currentCycle);
      await sleep(2000);
    } finally {
      this.state.isRunning = false;
      if (!this.state.isLoop || this.state.shouldStop) {
        this.state.status = 'STOPPED';
        this.addLog('info', '⏹️ Processo finalizado', this.currentCycle);
      }
    }
  }

  private async mockPipeline(): Promise<void> {
    const steps: Array<{ action: string; status?: AppStatus; delay: number }> = [
      { action: 'Criando email temporário', delay: 1000 },
      { action: 'Abrindo página de cadastro', delay: 1500 },
      { action: 'Preenchendo campo email', delay: 800 },
      { action: 'Aguardando OTP', status: 'WAITING_OTP', delay: 4000 },
      { action: 'Preenchendo código OTP', delay: 1200 },
      { action: 'Preenchendo telefone', delay: 800 },
      { action: 'Preenchendo senha', delay: 600 },
      { action: 'Preenchendo nome completo', delay: 800 },
      { action: 'Selecionando localização', delay: 1000 },
      { action: 'Preenchendo código de indicação', delay: 600 },
      { action: 'Finalizando - Foto de perfil', delay: 1500 },
    ];

    for (const step of steps) {
      if (this.state.shouldStop) {
        this.state.status = 'STOPPING';
        throw new Error('Parando após ciclo atual');
      }
      if (step.status) this.state.status = step.status;
      this.addLog('info', `📝 ${step.action}`, this.currentCycle);
      await sleep(step.delay + this.state.config.extraDelay);
    }
  }
}

export const globalState = new GlobalState();
