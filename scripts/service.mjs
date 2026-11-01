import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'darwin')
  throw new Error('This script manages macOS launchd. Use Docker or a service manager on Linux.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'dev.goalloop.server';
const plist = path.join(homedir(), 'Library/LaunchAgents', label + '.plist');
const target = `gui/${process.getuid()}`;
const action = process.argv[2] || 'status';
const xml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
if (action === 'install') {
  if (!existsSync(path.join(root, 'dist/cli.js'))) throw new Error('Run pnpm build first');
  mkdirSync(path.join(root, '.data/logs'), { recursive: true });
  mkdirSync(path.dirname(plist), { recursive: true });
  if (existsSync(plist))
    try {
      execFileSync('launchctl', ['bootout', target, plist], { stdio: 'ignore' });
    } catch {}
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(root, 'dist/cli.js'))}</string><string>serve</string><string>--worker</string></array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${path.dirname(process.execPath)}:${path.join(homedir(), '.local/bin')}:/opt/homebrew/bin:/usr/bin:/bin`)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(root, '.data/logs/server.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(root, '.data/logs/error.log'))}</string></dict></plist>`,
    { mode: 0o600 },
  );
  execFileSync('launchctl', ['bootstrap', target, plist], { stdio: 'inherit' });
  console.log(`Installed ${label}; logs in .data/logs`);
} else if (action === 'uninstall') {
  if (existsSync(plist)) {
    try {
      execFileSync('launchctl', ['bootout', target, plist], { stdio: 'inherit' });
    } finally {
      unlinkSync(plist);
    }
  }
  console.log('Service uninstalled; database and artifacts retained.');
} else if (action === 'status')
  execFileSync('launchctl', ['print', `${target}/${label}`], { stdio: 'inherit' });
else throw new Error('Use install | uninstall | status');
