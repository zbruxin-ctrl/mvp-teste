import { AppState, AppStatus, Config, LogEntry } from '../types';

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
      headless: true
    },
    shouldStop: false
  };

  private logs: LogEntry[] = [];
  private currentCycle = 0;

  getState(): AppState {
    return { ...this.state };
  }

  updateConfig(config: Partial<Config>): void {
    this.state.config = { ...this.state.config, ...config };
    this.addLog('info', 'Configuração atualizada');
  }

  async startLoop(): Promise<void> {
    this.state.isLoop = true;
    this.state.shouldStop = false;
    this.state.status = 'STARTING';
    this.addLog('info', '🔄 Loop iniciado', 0);
    
    while (this.state.isLoop && !this.state.shouldStop) {
      await this.executeCycle();
      if (this.state.isLoop && !this.state.shouldStop) {
        this.addLog('info', `⏳ Aguardando ${Math.round(this.state.config.cycleInterval/1000)}s para próximo ciclo...`);
        await this.sleep(this.state.config.cycleInterval);
      }
    }
  }

  async startOnce(): Promise<void> {
    this.state.isLoop = false;
    this.state.shouldStop = false;
    await this.executeCycle();
  }

  private async executeCycle(): Promise<void> {
    this.currentCycle++;
    this.state.cyclesTotal++;
    this.state.status = 'RUNNING';
    this.state.isRunning = true;
    
    try {
      this.addLog('info', `🚀 Iniciando ciclo #${this.currentCycle}`, this.currentCycle);
      
      // Simular pipeline completo
      await this.mockPipeline();
      
      this.state.cyclesCompleted++;
      this.addLog('success', `✅ Ciclo #${this.currentCycle} concluído com sucesso!`, this.currentCycle);
      
    } catch (error) {
      this.state.status = 'ERROR';
      this.state.lastError = error instanceof Error ? error.message : 'Erro desconhecido';
      this.addLog('error', `❌ Falha no ciclo #${this.currentCycle}: ${this.state.lastError}`, this.currentCycle);
      await this.sleep(2000);
    } finally {
      this.state.isRunning = false;
      if (!this.state.isLoop || this.state.shouldStop) {
        this.state.status = 'STOPPED';
        this.addLog('info', '⏹️ Processo finalizado', this.currentCycle);
      }
    }
  }

  private async mockPipeline(): Promise<void> {
    const steps = [
      { action: 'Criando email temporário', delay: 1000 },
      { action: 'Abrindo página de cadastro', delay: 1500 },
      { action: 'Preenchendo campo email', delay: 800 },
      { action: 'Aguardando OTP', status: 'WAITING_OTP' as const, delay: 4000 },
      { action: 'Preenchendo código OTP', delay: 1200 },
      { action: 'Preenchendo telefone', delay: 800 },
      { action: 'Preenchendo senha', delay: 600 },
      { action: 'Confirmando senha', delay: 600 },
      { action: 'Preenchendo nome completo', delay: 800 },
      { action: 'Selecionando localização', delay: 1000 },
      { action: 'Preenchendo código de indicação', delay: 600 },
      { action: 'Finalizando - Foto de perfil', delay: 1500 }
    ];

    for (const step of steps) {
      if (this.state.shouldStop) {
        this.state.status = 'STOPPING';
        throw new Error('Parando após ciclo atual');
      }

      if (step.status) {
        this.state.status = step.status;
      }

      this.addLog('info', `📝 ${step.action}`, this.currentCycle);
      await this.sleep(step.delay + this.state.config.extraDelay);
    }
  }

  stop(): void {
    if (this.state.status === 'RUNNING' || this.state.status === 'WAITING_OTP') {
      this.state.shouldStop = true;
      this.state.status = 'STOPPING';
      this.addLog('warn', '🛑 Parando após ciclo atual...', this.currentCycle);
    } else {
      this.state.isRunning = false;
      this.state.isLoop = false;
      this.state.status = 'STOPPED';
      this.addLog('info', '⏹️ Processo parado', this.currentCycle);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  addLog(level: LogEntry['level'], message: string, cycle?: number): void {
    const log: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      cycle
    };
    this.logs.unshift(log);
    if (this.logs.length > 200) {
      this.logs = this.logs.slice(0, 200);
    }
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }
}

export const globalState = new GlobalState();

import { globalState } from './globalState';
import { TempMailClient } from '../tempMail/client';
import { gerarPayloadCompleto } from '../utils/dataGenerators';

class GlobalState {
  // ... código existente ...

  private async executeCycleReal(): Promise<void> {
    this.currentCycle++;
    this.state.cyclesTotal++;
    this.state.status = 'RUNNING';
    this.state.isRunning = true;
    
    const client = new TempMailClient(this.state.config.tempMailApiKey);
    
    try {
      // 1. CRIAR EMAIL
      this.addLog('info', `🚀 Ciclo #${this.currentCycle} - Iniciando`, this.currentCycle);
      const emailResult = await client.createRandomEmail();
      this.addLog('success', `📧 Email: ${emailResult.email}`, this.currentCycle);
      
      // 2. GERAR PAYLOAD
      const payload = gerarPayloadCompleto(emailResult);
      this.addLog('info', `👤 ${payload.nome} ${payload.sobrenome}`, this.currentCycle);
      this.addLog('info', `📞 ${payload.telefone}`, this.currentCycle);
      
      // 3. SIMULAR PASSOS DO FORMULÁRIO
      const steps = [
        'Abrindo página de cadastro',
        'Preenchendo email',
        'Aguardando OTP',
        'Preenchendo OTP',
        'Preenchendo telefone',
        'Preenchendo senha connect@10',
        'Preenchendo nome e sobrenome',
        'Marcando "Concordo"',
        'Digitando "Itajubá, MG, Brasil"',
        'Selecionando no dropdown',
        'Preenchendo código gkd2n7c',
        'Selecionando "Não ativar"',
        'Clicando "Foto de perfil"'
      ];

      for (let i = 0; i < steps.length; i++) {
        if (this.state.shouldStop) {
          this.state.status = 'STOPPING';
          throw new Error('Parando após ciclo atual');
        }

        // OTP especial no passo 4
        if (i === 2) {
          this.state.status = 'WAITING_OTP';
          const timeout = this.state.config.otpTimeout;
          const otpResult = await client.waitForOTP(emailResult.md5, timeout);
          this.addLog('success', `🔢 OTP: ${otpResult}`, this.currentCycle);
          steps[i] = `Preenchendo OTP: ${otpResult}`;
        }

        this.addLog('info', `📝 ${steps[i]}`, this.currentCycle);
        await this.sleep(this.state.config.extraDelay + (i * 500)); // Delay progressivo
      }

      this.state.cyclesCompleted++;
      this.addLog('success', `🎉 Ciclo #${this.currentCycle} CONCLUÍDO!`, this.currentCycle);
      
    } catch (error) {
      this.state.status = 'ERROR';
      this.state.lastError = error instanceof Error ? error.message : 'Erro desconhecido';
      this.addLog('error', `💥 ERRO ciclo #${this.currentCycle}: ${this.state.lastError}`, this.currentCycle);
      
      // Reintentos automáticos para OTP timeout
      if (this.state.lastError?.includes('Timeout')) {
        this.addLog('warn', '🔄 Tentando próximo ciclo...', this.currentCycle);
      }
    } finally {
      this.state.isRunning = false;
      if (!this.state.isLoop || this.state.shouldStop) {
        this.state.status = 'STOPPED';
      }
    }
  }

  // Substitui executeCycle() anterior
  private async executeCycle(): Promise<void> {
    await this.executeCycleReal();
  }

  // ... resto do código igual ...
}

import { AppState, Config, LogEntry } from '../types';

class GlobalState {
  private state: AppState = {
    isRunning: false,
    isLoop: false,
    cyclesCompleted: 0,
    cyclesTotal: 0,
    status: 'idle',
    config: {
      cadastroUrl: '',
      tempMailApiKey: '',
      otpTimeout: 30000,
      cycleInterval: 60000,
      extraDelay: 2000,
      headless: true
    }
  };

  private logs: LogEntry[] = [];

  getState(): AppState {
    return { ...this.state };
  }

  updateConfig(config: Partial<Config>): void {
    this.state.config = { ...this.state.config, ...config };
    this.addLog('info', 'Configuração atualizada');
  }

  setRunning(running: boolean, isLoop: boolean = false): void {
    this.state.isRunning = running;
    this.state.isLoop = isLoop;
    this.state.status = running ? 'running' : 'idle';
    this.addLog('info', `Status: ${running ? (isLoop ? 'Loop iniciado' : 'Ciclo único iniciado') : 'Parado'}`);
  }

  setStatus(status: AppState['status'], error?: string): void {
    this.state.status = status;
    if (error) {
      this.state.lastError = error;
      this.addLog('error', error);
    }
  }

  incrementCycle(): void {
    this.state.cyclesCompleted++;
    this.addLog('info', `Ciclo ${this.state.cyclesCompleted} concluído`);
  }

  resetCycles(): void {
    this.state.cyclesCompleted = 0;
    this.state.cyclesTotal = 0;
  }

  addLog(level: LogEntry['level'], message: string): void {
    const log: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message
    };
    this.logs.unshift(log);
    if (this.logs.length > 100) {
      this.logs = this.logs.slice(0, 100);
    }
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }
}

export const globalState = new GlobalState();