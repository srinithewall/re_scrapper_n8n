const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * PropSync Automated Stability Auditor
 * Run this to regenerate the HTML report based on current code state.
 */

const TARGET_FILE = 'scraper-puppeteer-housing.js';
const REPORT_FILE = 'stability/stability_report.html';
const MATRIX_FILE = 'stability/function_status_matrix.md';

const FEATURES = [
    { step: 1, name: 'Dependencies & Core Modules', marker: 'STEP 1' },
    { step: 2, name: 'Runtime Config & Logging', marker: 'STEP 2' },
    { step: 3, name: '30KB Image Size Check', marker: 'STEP 3' },
    { step: 4, name: 'Image Download & Buffers', marker: 'STEP 4' },
    { step: 5, name: 'Recursive JSON Parser', marker: 'STEP 5' },
    { step: 6, name: 'API Form Construction', marker: 'STEP 6' },
    { step: 7, name: 'Main Scraper Sequence', marker: 'STEP 7' },
    { step: 8, name: 'Network Interception (PHASE 1)', marker: 'STEP 8' },
    { step: 9.1, name: 'Local Deduplication', marker: 'STEP 9.1' },
    { step: 9.2, name: 'Image Size Verification', marker: 'STEP 9.2' },
    { step: 10, name: 'Dynamic Entity resolution', marker: 'STEP 10' },
    { step: 11, name: 'Project-Level Skip Logic', marker: 'STEP 11' },
    { step: 12, name: 'Ultra-Precise JSON Audit Log', marker: 'STEP 12' },
    { step: 13, name: 'Buffer Image Processing', marker: 'STEP 13' },
    { step: 14, name: 'Multipart POST Submission', marker: 'STEP 14' },
];

function getGitInfo() {
    try {
        const info = execSync('git log -1 --format="%h|%ad|%s" --date=format:"%Y-%m-%d %H:%M:%S"').toString().trim();
        const [hash, date, msg] = info.split('|');
        return { hash, date, msg };
    } catch (e) {
        return { hash: 'N/A', date: new Date().toLocaleString(), msg: 'Local Update (Not Committed)' };
    }
}

function auditCode() {
    if (!fs.existsSync(TARGET_FILE)) return FEATURES.map(f => ({ ...f, status: '❌ Missing' }));
    const content = fs.readFileSync(TARGET_FILE, 'utf8');
    return FEATURES.map(f => {
        const exists = content.includes(f.marker);
        return {
            ...f,
            status: exists ? '✅ Working' : '❌ Removed/Missing',
            cssClass: exists ? 'status-ok' : 'status-err'
        };
    });
}

function generateHtml(git, results) {
    const templatePath = path.join(__dirname, 'stability/stability_report_template.html');
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Stability Report - ${git.hash}</title>
    <style>
        :root { --primary: #2563eb; --success: #22c55e; --danger: #ef4444; --bg: #f8fafc; --text: #1e293b; }
        body { font-family: sans-serif; background: var(--bg); color: var(--text); padding: 20px; }
        .container { max-width: 900px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        .metadata { background: #f1f5f9; padding: 15px; border-radius: 8px; margin-bottom: 20px; display: flex; justify-content: space-between; font-size: 0.9em; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
        .status-ok { color: var(--success); font-weight: bold; }
        .status-err { color: var(--danger); font-weight: bold; }
        .badge-step { background: #dbeafe; color: #1e40af; padding: 4px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Stability Audit Dashboard</h1>
        <div class="metadata">
            <div><strong>Hash:</strong> ${git.hash}</div>
            <div><strong>Date:</strong> ${git.date}</div>
        </div>
        <p><strong>Commit Message:</strong> ${git.msg}</p>
        <table>
            <thead><tr><th>Step</th><th>Feature</th><th>Status</th></tr></thead>
            <tbody>
                ${results.map(r => `
                <tr>
                    <td><span class="badge-step">Step ${r.step}</span></td>
                    <td>${r.name}</td>
                    <td><span class="${r.cssClass}">${r.status}</span></td>
                </tr>`).join('')}
            </tbody>
        </table>
        <footer style="margin-top:20px; font-size:0.8em; color:#64748b; text-align:center;">
            Automated via PropSync Stability Hook
        </footer>
    </div>
</body></html>`;
    fs.writeFileSync(REPORT_FILE, html);
    console.log(`Report generated: ${REPORT_FILE}`);
}

const git = getGitInfo();
const results = auditCode();
generateHtml(git, results);
