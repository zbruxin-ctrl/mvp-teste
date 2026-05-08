export interface Config {
  cadastroUrl: string;
  tempMailApiKey: string;
  otpTimeout: number;
  cycleInterval: number;
  extraDelay: number;
  headless: boolean;
}

export type AppStatus = 
  | 'STOPPED'
  | 'STARTING' 
  | 'RUNNING'
  | 'WAITING_OTP'
  | 'STOPPING'
  | 'ERROR';

export interface AppState {
  isRunning: boolean;
  isLoop: boolean;
  cyclesCompleted: number;
  cyclesTotal: number;
  status: AppStatus;
  lastError?: string;
  config: Config;
  shouldStop: boolean; // Flag para parar após ciclo atual
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  cycle?: number;
}

export interface Config {
  cadastroUrl: string;
  tempMailApiKey: string;
  otpTimeout: number;
  cycleInterval: number;
  extraDelay: number;
  headless: boolean;
}

export interface AppState {
  isRunning: boolean;
  isLoop: boolean;
  cyclesCompleted: number;
  cyclesTotal: number;
  status: 'idle' | 'running' | 'stopped' | 'error';
  lastError?: string;
  config: Config;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}