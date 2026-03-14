const fs = require('fs');
const path = require('path');

/**
 * Installs the stability-audit as a Git post-commit hook.
 */

const hookPath = '.git/hooks/post-commit';
const hookContent = `#!/bin/sh
node stability-audit.js
`;

function setup() {
    if (!fs.existsSync('.git')) {
        console.error('Error: .git directory not found. Please run "git init" first.');
        process.exit(1);
    }

    try {
        fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
        console.log(`Success: Git hook installed at ${hookPath}`);
        console.log('The Stability Report will now update automatically every time you commit.');
    } catch (e) {
        console.error(`Error: Failed to write hook. ${e.message}`);
    }
}

setup();
