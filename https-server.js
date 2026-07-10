// スマホ実機でマイク（getUserMedia）を検証するためのローカルHTTPS配信サーバー。
// getUserMedia はセキュアコンテキスト（https または localhost）でしか動かず、
// スマホは http://<LAN-IP> でアクセスするため HTTPS が必須になる。
//
// 使い方: node https-server.js
//   → https://localhost:8443/ および https://<LAN-IP>:8443/ で配信
// 証明書は .certs/ の自己署名証明書を使う（スマホでは「安全でない接続」警告を承認して進む）。
//
// 依存ライブラリなし（Node 標準モジュールのみ）。静的ファイルを配信するだけの最小実装。

import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

const PORT = 8443;
const ROOT = process.cwd();
const CERT_DIR = join(ROOT, '.certs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ico': 'image/x-icon',
};

const certPath = join(CERT_DIR, 'cert.pem');
const keyPath = join(CERT_DIR, 'key.pem');
if (!existsSync(certPath) || !existsSync(keyPath)) {
  console.error('証明書が見つかりません。先に .certs/cert.pem と .certs/key.pem を生成してください。');
  process.exit(1);
}

const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);

const server = createServer({ cert, key }, async (req, res) => {
  try {
    // クエリを除き、パストラバーサル（..）を正規化で無効化する
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const relative = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');

    // ドット始まりのセグメント（.certs / .git / .env 等）へのアクセスは拒否する。
    // 自己署名証明書の秘密鍵が同一LAN上の他端末に漏れるのを防ぐ
    if (relative.split(/[/\\]/).some((seg) => seg.startsWith('.') && seg !== '.')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return;
    }

    let filePath = join(ROOT, relative === '/' || relative === '\\' ? 'index.html' : relative);
    if (filePath.endsWith('/') || filePath.endsWith('\\')) filePath = join(filePath, 'index.html');

    // ROOT の外へ出るリクエストは拒否する（正規化後に ROOT 配下であることを再確認）
    if (filePath !== ROOT && !filePath.startsWith(ROOT + '\\') && !filePath.startsWith(ROOT + '/')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return;
    }

    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const addresses = ['localhost'];
  for (const iface of Object.values(networkInterfaces())) {
    for (const info of iface ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  console.log('HTTPS配信を開始しました。スマホは同じWi-Fiから以下のいずれかを開いてください:');
  for (const address of addresses) console.log(`  https://${address}:${PORT}/`);
  console.log('※ 自己署名証明書のため「安全でない接続」警告が出ます。詳細 → このまま続行 で進めます。');
});
