import { run, type Runner } from './exec';

export async function openTerminal(runner: Runner = run): Promise<void> {
  await runner('open', ['-a', 'Terminal'], { timeoutMs: 10000 });
}
