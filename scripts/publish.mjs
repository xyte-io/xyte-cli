#!/usr/bin/env node

import { runOrThrow } from './run_command.mjs';

const mode = process.argv[2] ?? 'all';
const repo = process.env.GITHUB_REPOSITORY ?? 'xyte-io/xyte-cli';
const workflow = process.env.PAGES_WORKFLOW ?? 'pages.yml';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const ghCommand = process.platform === 'win32' ? 'gh.exe' : 'gh';

function usage() {
  process.stdout.write(
    [
      'Usage: scripts/publish.mjs [cli|pages|all]',
      '',
      '  cli    Publish @xyteai/cli to npm',
      '  pages  Trigger GitHub Pages deployment workflow',
      '  all    Publish npm package, then trigger Pages deployment (default)'
    ].join('\n') + '\n'
  );
}

async function run(command, args, label) {
  process.stdout.write(`${label}\n`);
  await runOrThrow(command, args, label, {
    env: process.env
  });
}

async function publishCli() {
  await run(npmCommand, ['whoami'], 'Checking npm auth...');
  await run(npmCommand, ['publish'], 'Publishing @xyteai/cli...');
}

async function publishPages() {
  await run(ghCommand, ['auth', 'status'], 'Checking GitHub auth...');
  await run(ghCommand, ['workflow', 'run', workflow, '--repo', repo], `Triggering GitHub Pages workflow (${workflow}) for ${repo}...`);
  process.stdout.write(`Pages workflow triggered. Monitor with:\n${ghCommand} run list --repo ${repo} --workflow ${workflow} --limit 1\n`);
}

if (mode === '-h' || mode === '--help') {
  usage();
} else if (mode === 'cli') {
  await publishCli();
} else if (mode === 'pages') {
  await publishPages();
} else if (mode === 'all') {
  await publishCli();
  await publishPages();
} else {
  usage();
  process.exitCode = 1;
}
