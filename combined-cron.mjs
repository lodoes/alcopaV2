#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JOBS = {
  alcopa: 'cron-all-sales.mjs',
  interencheres: 'interencheres-cron.mjs',
};

function log(event, data = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
}

function selectCombinedCronJob(now = new Date(), override = process.env.COMBINED_CRON_JOB || '') {
  const requested = String(override).trim().toLowerCase();
  if (requested && requested !== 'auto') {
    if (!JOBS[requested]) throw new Error(`COMBINED_CRON_JOB invalide: ${override}`);
    return requested;
  }
  return now.getUTCHours() === 2 ? 'alcopa' : 'interencheres';
}

async function runCombinedCron() {
  const job = selectCombinedCronJob();
  const script = JOBS[job];
  const scriptPath = fileURLToPath(new URL(`./${script}`, import.meta.url));
  log('combined_cron_dispatch', {
    job,
    script,
    utcHour: new Date().getUTCHours(),
    region: process.env.RAILWAY_REPLICA_REGION || null,
  });

  let child = null;
  const forwardSignal = (signal) => {
    log('combined_cron_signal', { job, signal });
    if (child && !child.killed) child.kill(signal);
  };
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));
  process.once('SIGINT', () => forwardSignal('SIGINT'));

  const result = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [scriptPath], {
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  log('combined_cron_finished', { job, ...result });
  if (result.code !== 0) process.exitCode = result.code || 1;
  return { job, ...result };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCombinedCron().catch((error) => {
    log('combined_cron_failed', { error: error.message });
    process.exitCode = 1;
  });
}

export { runCombinedCron, selectCombinedCronJob };
