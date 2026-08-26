const fs = require('fs');
const https = require('https');

const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
const fileContent = fs.readFileSync('test.csv');
const body = Buffer.concat([
  Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="test.csv"\r\nContent-Type: text/csv\r\n\r\n'),
  fileContent,
  Buffer.from('\r\n--' + boundary + '--\r\n')
]);

const req = https.request({
  hostname: 'api.continuumapi.com',
  path: '/v1/bulk-jobs',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer cnt_4b5a6518f4cfc58d65c3443d9979bc118a1b23b91f0d9d30',
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': body.length
  }
}, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => console.log(data));
});

req.write(body);
req.end();
