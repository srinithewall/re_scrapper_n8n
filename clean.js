const http = require('http');

const ENDPOINT = 'http://43.204.221.192:8880/api/re/projects/';

async function deleteProject(id) {
    return new Promise((resolve) => {
        const req = http.request(ENDPOINT + id, { method: 'DELETE' }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', () => resolve({ status: 500 }));
        req.end();
    });
}

async function run() {
    console.log("Starting deletion of projects ID 60 to 120...");
    for (let i = 60; i <= 120; i++) {
        const res = await deleteProject(i);
        if (res.status === 200) {
            try {
                const b = JSON.parse(res.body);
                if (b.message && !b.message.includes("already deleted")) {
                    console.log(`Deleted project ${i}: ${b.message}`);
                }
            } catch (e) {
                console.log(`Deleted project ${i}`);
            }
        }
    }
    console.log("Cleanup complete.");
}

run();
