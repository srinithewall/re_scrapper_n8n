const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SOURCE_SCRIPTS = {
  housing: 'scraper-modular.js',
  '99acres': 'scraper-puppeteer.js',
  modular: 'scraper-modular.js',
};

function parseArgValue(args, name) {
  const key = `--${name}=`;
  const hit = args.find((arg) => arg.startsWith(key));
  return hit ? hit.slice(key.length) : null;
}

function parseSources(args) {
  const raw = parseArgValue(args, 'sources') || parseArgValue(args, 'source') || '99acres';
  const unique = [...new Set(
    raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  )];

  const invalid = unique.filter((name) => !SOURCE_SCRIPTS[name]);
  if (invalid.length > 0) {
    throw new Error(`Unsupported source(s): ${invalid.join(', ')}`);
  }

  return unique;
}

function withoutInternalArgs(args) {
  return args.filter((arg) =>
    !arg.startsWith('--source=') &&
    !arg.startsWith('--sources=')
  );
}

function safeName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function createRunFiles(sourceName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(__dirname, 'debug', 'n8n-runs', timestamp);
  fs.mkdirSync(runDir, { recursive: true });

  return {
    runDir,
    outputFile: path.join(runDir, `${safeName(sourceName)}-scraped.json`),
    reportFile: path.join(runDir, `${safeName(sourceName)}-report.json`),
  };
}

function loadJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {
      parseError: error.message,
      filePath,
    };
  }
}

function summarizeReport(report) {
  if (!report || typeof report !== 'object') {
    return null;
  }

  return {
    success: Array.isArray(report.success) ? report.success.length : 0,
    skipped: Array.isArray(report.skipped) ? report.skipped.length : 0,
    failed: Array.isArray(report.failed) ? report.failed.length : 0,
  };
}

function runSource(sourceName, forwardedArgs, options = {}) {
  const files = createRunFiles(sourceName);
  const scriptName = SOURCE_SCRIPTS[sourceName] || 'scraper-modular.js';
  const commandArgs = [
    scriptName,
    ...forwardedArgs,
  ];

  // Only add output/report files if they aren't already in forwardedArgs
  if (!forwardedArgs.some(a => a.startsWith('--output-file='))) {
    commandArgs.push(`--output-file=${files.outputFile}`);
  }
  if (!forwardedArgs.some(a => a.startsWith('--report-file='))) {
    commandArgs.push(`--report-file=${files.reportFile}`);
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, commandArgs, {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const writeChildLog = typeof options.onChildLog === 'function'
      ? options.onChildLog
      : (text) => process.stderr.write(text);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      writeChildLog(text, { source: sourceName, stream: 'stdout' });
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      writeChildLog(text, { source: sourceName, stream: 'stderr' });
    });

    child.on('close', (exitCode) => {
      const report = loadJsonIfPresent(files.reportFile);
      resolve({
        source: sourceName,
        script: scriptName,
        exitCode,
        ok: exitCode === 0,
        command: [process.execPath, ...commandArgs].join(' '),
        outputFile: files.outputFile,
        reportFile: files.reportFile,
        totals: summarizeReport(report),
        report,
        stdoutTail: stdout.trim().split(/\r?\n/).slice(-20),
        stderrTail: stderr.trim().split(/\r?\n/).slice(-20),
        stdout: stdout.trim(),
      });
    });
  });
}

async function runFromArgs(args, options = {}) {
  const sources = parseSources(args);
  const forwardedArgs = withoutInternalArgs(args);
  const startedAt = new Date().toISOString();
  const results = [];

  for (const sourceName of sources) {
    const result = await runSource(sourceName, forwardedArgs, options);
    results.push(result);
  }

  const ok = results.every((result) => result.ok);
  return {
    ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    sources: results,
  };
}

async function main() {
  const payload = await runFromArgs(process.argv.slice(2));

  process.stdout.write(JSON.stringify(payload, null, 2));

  if (!payload.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: error.message,
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  runFromArgs,
};
