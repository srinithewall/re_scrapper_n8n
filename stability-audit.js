const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * PropSync Automated Stability Auditor (History Version)
 * Generates UNIQUE reports for every commit and updates a master Index.
 */

const TARGET_FILE = 'scraper-puppeteer-housing.js';
const REPORTS_DIR = 'stability/reports';
const INDEX_FILE = 'stability/index.html';
const HISTORY_FILE = 'stability/audit_history.json';

// Ensure directory exists
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

function getGitInfo() {
    try {
        const info = execSync('git log -1 --format="%h|%ad|%s" --date=format:"%Y-%m-%d %H:%M:%S"').toString().trim();
        const [hash, date, msg] = info.split('|');
        return { hash, date, msg };
    } catch (e) {
        return { hash: 'N/A', date: new Date().toISOString(), msg: 'Local Update (Not Committed)' };
    }
}

function discoverFeatures() {
    if (!fs.existsSync(TARGET_FILE)) return [];
    const content = fs.readFileSync(TARGET_FILE, 'utf8');
    const lines = content.split('\n');
    const features = [];
    const stepRegex = /\/\/\s*STEP\s+([\d.]+):\s*(.*)/i;
    
    lines.forEach(line => {
        const match = line.match(stepRegex);
        if (match) {
            features.push({
                step: match[1],
                name: match[2].trim(),
                status: 'Working',
                icon: '✅'
            });
        }
    });
    return features;
}

function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
        catch (e) { return []; }
    }
    return [];
}

function generateReportHtml(current, previous) {
    const git = current.git;
    const timestamp = git.date.replace(/[: ]/g, '-');
    const reportFilename = `audit-${git.hash}-${timestamp}.html`;
    const reportPath = path.join(REPORTS_DIR, reportFilename);
    const prevGit = previous ? previous.git : null;

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Audit: ${git.hash}</title>
    <style>
        :root { --primary: #2563eb; --success: #22c55e; --danger: #ef4444; --bg: #f8fafc; --text: #1e293b; --gray: #64748b; }
        body { font-family: sans-serif; background: var(--bg); color: var(--text); padding: 20px; }
        .container { max-width: 1000px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        .nav { margin-bottom: 20px; }
        .nav a { color: var(--primary); text-decoration: none; font-weight: bold; }
        .metadata-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
        .metadata-box { background: #f1f5f9; padding: 15px; border-radius: 8px; font-size: 0.9em; border-left: 4px solid var(--primary); }
        .metadata-box.previous { border-left-color: var(--gray); opacity: 0.8; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
        th { background: #f8fafc; color: var(--primary); }
        .status-Working { color: var(--success); font-weight: bold; }
        .status-Removed { color: var(--danger); font-weight: bold; }
        .badge-step { background: #dbeafe; color: #1e40af; padding: 4px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold; }
        .change-indicator { font-size: 0.8em; padding: 2px 6px; border-radius: 100px; margin-left: 10px; }
        .change-stable { background: #f1f5f9; color: var(--gray); }
        .change-regression { background: #fee2e2; color: var(--danger); }
        .change-improvement { background: #dcfce7; color: var(--success); }
    </style>
</head>
<body>
    <div class="container">
        <div class="nav"><a href="../index.html">← Back to History Index</a></div>
        <h1>Audit Report: ${git.hash}</h1>
        <div class="metadata-grid">
            <div class="metadata-box">
                <strong>Commit Context</strong><br>
                Date: ${git.date}<br>
                Msg: ${git.msg}
            </div>
            ${prevGit ? `<div class="metadata-box previous"><strong>Compared to Previous</strong><br>Hash: ${prevGit.hash}<br>Date: ${prevGit.date}</div>` : '<div></div>'}
        </div>
        <table>
            <thead><tr><th>Step</th><th>Feature</th><th>Prev</th><th>Current</th><th>Change</th></tr></thead>
            <tbody>
                ${current.results.map((r, i) => {
                    const p = previous ? previous.results.find(res => res.step === r.step) : null;
                    let diffClass = 'change-stable', diffText = 'Stable';
                    if (p && p.status !== r.status) {
                        if (r.status === 'Working') { diffClass = 'change-improvement'; diffText = 'Restored ✅'; }
                        else { diffClass = 'change-regression'; diffText = 'REGRESSION ❌'; }
                    } else if (!p && previous) { diffClass = 'change-improvement'; diffText = 'NEW ✨'; }
                    return `<tr>
                        <td><span class="badge-step">Step ${r.step}</span></td>
                        <td>${r.name}</td>
                        <td class="${p ? 'status-' + p.status : ''}">${p ? p.icon : 'N/A'}</td>
                        <td class="status-${r.status}">${r.icon}</td>
                        <td><span class="change-indicator ${diffClass}">${diffText}</span></td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
    </div>
</body></html>`;
    fs.writeFileSync(reportPath, html);
    console.log(`Unique report generated: ${reportPath}`);
}

function updateIndexHtml(history) {
    let listHtml = history.slice().reverse().map(h => {
        const timestamp = h.git.date.replace(/[: ]/g, '-');
        const filename = `reports/audit-${h.git.hash}-${timestamp}.html`;
        return `<tr>
            <td>${h.git.date}</td>
            <td><code>${h.git.hash}</code></td>
            <td>${h.git.msg}</td>
            <td><a href="${filename}">View Report</a></td>
        </tr>`;
    }).join('');

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Audit History Index</title>
    <style>
        body { font-family: sans-serif; background: #f8fafc; color: #1e293b; padding: 40px; }
        .container { max-width: 1000px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
        th { background: #f1f5f9; color: #2563eb; }
        a { color: #2563eb; text-decoration: none; font-weight: bold; }
        h1 { color: #2563eb; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Historical Stability Audit Index</h1>
        <p>This index is automatically updated after every commit. Each link represents a unique snapshot of the project stability at that time.</p>
        <table>
            <thead><tr><th>Date</th><th>Hash</th><th>Commit Message</th><th>Action</th></tr></thead>
            <tbody>${listHtml}</tbody>
        </table>
    </div>
</body></html>`;
    fs.writeFileSync(INDEX_FILE, html);
    console.log(`Index updated: ${INDEX_FILE}`);
}

const currentResults = discoverFeatures();
const git = getGitInfo();
const history = loadHistory();

const currentAudit = { git, results: currentResults };
const lastAudit = history.length > 0 ? history[history.length - 1] : null;

// Always generate report for current state
generateReportHtml(currentAudit, lastAudit);

// Update history and index only if it's a new commit hash
if (!lastAudit || lastAudit.git.hash !== git.hash) {
    history.push(currentAudit);
    if (history.length > 50) history.shift();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

updateIndexHtml(history);