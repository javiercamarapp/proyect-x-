"""Prueba el bus copiado con credencial sintética y servidor HTTP loopback."""
from pathlib import Path
import base64
import http.server
import json
import os
import shutil
import subprocess
import tempfile
import threading


received = []


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        data = self.rfile.read(int(self.headers['Content-Length']))
        body = json.loads(data)
        received.append({'path': self.path, 'wire_bytes': len(data), 'body': body})
        response = json.dumps({
            'ok': True,
            'sembradas': len(body.get('rutinas', [])),
        }).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, *_args):
        pass


with tempfile.TemporaryDirectory(prefix='worker-isolated-') as directory:
    root = Path(directory)
    repo = root / 'repo'
    scripts = repo / 'scripts' / 'mejora-diaria'
    scripts.mkdir(parents=True)
    encargos = scripts / 'encargos'
    encargos.mkdir()
    source = Path(__file__).resolve().parents[3] / 'scripts' / 'mejora-diaria'
    for name in ['bus.sh', 'worker_payloads.py']:
        shutil.copy2(source / name, scripts / name)
    for i in range(121):
        (encargos / f'r{i:03}.md').write_text('🚛' * 20000)

    pieza = root / 'likida-marketing-cola' / 'pieza'
    pieza.mkdir(parents=True)
    (pieza / 'post.md').write_text('🚛' * 4000)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (repo / '.env.local').write_text(
        'LIKIDA_WORKER_KEY=lkw_synthetic_review\n'
        f'LIKIDA_WORKER_URL=http://127.0.0.1:{server.server_port}\n'
    )
    # Conserva HOME. Los archivos leídos por estos dos verbos vienen del REPO
    # copiado: encargos, plists y .env.local; COLA deriva de ese mismo REPO.
    environment = {
        'HOME': os.environ['HOME'],
        'PATH': '/opt/homebrew/bin:/usr/bin:/bin',
        'LANG': 'en_US.UTF-8',
    }

    def run(arguments):
        result = subprocess.run(
            ['bash', str(scripts / 'bus.sh'), *arguments],
            env=environment,
            text=True,
            capture_output=True,
            timeout=30,
        )
        assert result.returncode == 0, result.stderr
        return {'stdout': result.stdout, 'stderr': result.stderr}

    try:
        report = {'catalog': run(['sembrar-catalogo'])}
        batches = [x for x in received if x['path'].endswith('/catalogo')]
        assert len(batches) == 3
        assert sum(len(x['body']['rutinas']) for x in batches) == 121
        assert [
            row['nombre'] for batch in batches for row in batch['body']['rutinas']
        ] == [f'r{i:03}' for i in range(121)]
        assert all(
            batch['wire_bytes'] <= 4400000 and len(batch['body']['rutinas']) <= 50
            for batch in batches
        )
        report['catalog']['batch_counts'] = [len(x['body']['rutinas']) for x in batches]
        report['catalog']['wire_sizes'] = [x['wire_bytes'] for x in batches]

        (pieza / 'preview.jpg').write_bytes(bytes(3 * 1024 * 1024))
        report['exact3MiB'] = run(['pieza', 'review', str(pieza)])
        exact = received[-1]
        assert len(base64.b64decode(exact['body']['mediaBase64'])) == 3 * 1024 * 1024
        assert exact['wire_bytes'] < 4400000
        report['exact3MiB']['wire_size'] = exact['wire_bytes']

        (pieza / 'preview.jpg').write_bytes(bytes(3 * 1024 * 1024 + 1))
        report['over3MiB'] = run(['pieza', 'review', str(pieza)])
        report['over3MiB']['media_omitted'] = 'mediaBase64' not in received[-1]['body']
        assert report['over3MiB']['media_omitted']
        assert 'Aviso:' in report['over3MiB']['stdout']
        assert 'sin vista previa' in report['over3MiB']['stdout']
        print(json.dumps(report, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
