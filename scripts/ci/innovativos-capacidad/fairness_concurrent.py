#!/usr/bin/env python3
"""Dos claims concurrentes reales sobre 5,000 trabajos sintéticos (DB propia)."""
from pathlib import Path
import argparse,concurrent.futures,json,re,stat,subprocess,threading,time
parser=argparse.ArgumentParser()
parser.add_argument('--db',required=True)
parser.add_argument('--host',required=True,help='Directorio de socket UNIX local; no TCP')
parser.add_argument('--port',required=True,type=int)
parser.add_argument('--out',type=Path,required=True)
args=parser.parse_args()
if not Path(args.host).is_absolute() or not 1<=args.port<=65535:parser.error('Host UNIX absoluto y puerto válido requeridos')
socket=Path(args.host)/f'.s.PGSQL.{args.port}'
if not socket.exists() or not stat.S_ISSOCK(socket.stat().st_mode):parser.error('Sólo socket PostgreSQL UNIX local existente')
if not re.fullmatch(r'innovativos_cap_[a-z0-9_]+',args.db):parser.error('Se exige prefijo propio innovativos_cap_')
DB=args.db
OUT=args.out
BASE=['psql','-h',args.host,'-p',str(args.port),'-d',DB,'-X','-v','ON_ERROR_STOP=1','-Atq']
def sql(q):
 r=subprocess.run([*BASE,'-c',q],text=True,capture_output=True,timeout=30)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
assert sql('select label from innovativos_cap_harness.owner where id=1')=='synthetic-only-0339'
assert sql('select count(*) from public.jornada_derivacion_trabajo')=='0', 'Requiere cola vacía propia; no sobrescribe backlog'
fixture=(OUT/'fairness.sql').read_text().split('create temp table first_claim')[0]+'commit;'
sql(fixture)
barrier=threading.Barrier(2)
def worker(n):
 barrier.wait();t=time.perf_counter()
 # Sostiene locks tras reclamar para exigir SKIP LOCKED al otro worker.
 result=sql(f"begin; select json_agg(x) from public.reclamar_jornadas_por_derivar(10,'synthetic-concurrent-{n}',30)x;select pg_sleep(1);rollback;")
 return {'worker':n,'seconds':time.perf_counter()-t,'claims':json.loads(result)}
try:
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:results=list(ex.map(worker,[1,2]))
 (OUT/'fairness-concurrent-raw.json').write_text(json.dumps(results,indent=2))
 ids=[]; aggregate={}
 for result in results:
  counts={}
  for row in result['claims']:counts[row['tenant_id']]=counts.get(row['tenant_id'],0)+1
  assert len(result['claims'])==10
  for tenant,n in counts.items():aggregate[tenant]=aggregate.get(tenant,0)+n
  ids.append({(r['tenant_id'],r['operador_id'],r['dia']) for r in result['claims']})
 assert sorted(aggregate.values())==[4]*5,aggregate
 assert not ids[0]&ids[1], 'Claims concurrentes se solapan'
 (OUT/'fairness-concurrent.json').write_text(json.dumps({'results':results,'overlap':0,'aggregate_four_per_tenant':True,'aggregate':aggregate,'per_worker_distribution':[{tenant:sum(1 for row in r['claims'] if row['tenant_id']==tenant) for tenant in {row['tenant_id'] for row in r['claims']}} for r in results]},indent=2));print('CONCURRENT_CLAIMS_PASS')
finally:
 # Fixture y claims son exclusivamente nuestros; no usa DELETE sobre datos de negocio.
 sql("delete from public.jornada_derivacion_trabajo where tenant_id in(select id from public.tenant where nombre like 'SINTETICO INNOVATIVOS CAP %')")
