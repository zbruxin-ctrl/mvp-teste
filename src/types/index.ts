export type AppStatus =
  | 'STOPPED'
  | 'STARTING'
  | 'RUNNING'
  | 'WAITING_OTP'
  | 'STOPPING'
  | 'ERROR';

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
  status: AppStatus;
  lastError?: string;
  config: Config;
  shouldStop: boolean;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success' | 'kyc';
  message: string;
  cycle?: number;
}
