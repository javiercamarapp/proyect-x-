import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('el cliente conserva 121 rutinas Unicode en lotes completos bajo el límite HTTP', () => {
  const salida = execFileSync('python3', ['-c', `
import sys,json,base64
sys.path.insert(0,'scripts/mejora-diaria')
from worker_payloads import lotes_catalogo,codificar,MAX_MEDIA_BYTES,MAX_BODY_BYTES
filas=[{'nombre':str(i),'encargo_md':'🚛'*20000} for i in range(121)]
lotes=list(lotes_catalogo(filas))
assert [f for b in lotes for f in json.loads(b)['rutinas']]==filas
assert all(len(b)<=MAX_BODY_BYTES for b in lotes)
assert all(len(json.loads(b)['rutinas'])<=50 for b in lotes)
pieza=codificar({'carpeta':'p','copyMd':'🚛'*4000,'mediaBase64':base64.b64encode(bytes(MAX_MEDIA_BYTES)).decode()})
assert len(pieza)<4500000
try: codificar({'x':'x'*MAX_BODY_BYTES})
except ValueError: pass
else: raise AssertionError('exceso aceptado')
print(json.dumps({'rutinas':len(filas),'lotes':len(lotes),'maximo':max(map(len,lotes)),'pieza':len(pieza)}))
`], { encoding: 'utf8' });
  expect(JSON.parse(salida)).toMatchObject({ rutinas: 121, lotes: 3 });
});
