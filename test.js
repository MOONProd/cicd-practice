const http = require('http');
const app = require('./index');

const server = app.listen(0, () => {
  const port = server.address().port;

  http.get(`http://localhost:${port}/health`, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      const body = JSON.parse(data);
      if (res.statusCode === 200 && body.status === 'ok') {
        console.log('PASS: /health returned ok');
        server.close();
        process.exit(0);
      } else {
        console.error('FAIL: unexpected response', res.statusCode, body);
        server.close();
        process.exit(1);
      }
    });
  });
});
