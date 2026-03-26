const http = require('http');
const https = require('https');
const fs = require('fs');

const API_URL = 'http://43.204.221.192:8880/api/re/projects';
const USER_ID = '1';

function buildMultipart(fields, files = []) {
  const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
  const parts = [];
  const CRLF = Buffer.from('\r\n');

  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`));
  }

  for (const file of files) {
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`);
    parts.push(Buffer.concat([header, file.buffer, CRLF]));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function test() {
  const fields = {
    projectName: "Test Project - Antigravity",
    description: "Binary test submission",
    reraNumber: "TEST/123/XYZ",
    developerId: 1,
    projectTypeId: 1,
    constructionStatusid: 5,
    possessionDate: "2026-12-01",
    sourceName: "test-script",
    sourceType: "MANUAL",
    'location.city': "Bengaluru",
    'location.area': "Test Area",
    'location.addressLine': "123 Test Street",
    'location.latitude': 12.97,
    'location.longitude': 77.59,
    'amenityIds[0]': 5,
    'images[0].sortOrder': 1,
    'images[0].imageType': 'GALLERY',
    'images[0].fileSize': 1000
  };

  const dummyImage = Buffer.alloc(1000, 'ABC'); // 1KB dummy
  const files = [{
    fieldName: 'images[0].file',
    fileName: 'test.jpg',
    mimeType: 'image/jpeg',
    buffer: dummyImage
  }];

  const { body, contentType } = buildMultipart(fields, files);

  const pu = new URL(API_URL);
  const lib = pu.protocol === 'https:' ? https : http;

  const req = lib.request({
    hostname: pu.hostname,
    port: pu.port || 80,
    path: pu.pathname,
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Accept': 'application/json',
      'X-USER-ID': USER_ID
    }
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      console.log(`Status: ${res.statusCode}`);
      console.log(`Body: ${d}`);
    });
  });

  req.on('error', e => console.error(e));
  req.write(body);
  req.end();
}

test();
