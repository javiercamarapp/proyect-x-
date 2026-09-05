#!/usr/bin/env python3
"""Reproduce el historial local 0001..0303 y actualiza datos sintéticos a0339.
Nunca utiliza credenciales remotas ni una copia de producción.
"""
import argparse,datetime,hashlib,json,re,stat,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
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
OUT=args.out;OUT.mkdir(parents=True,exist_ok=True)
DB=args.db
BASE=['-h',args.host,'-p',str(args.port)]
def run(args):
 t=time.perf_counter();r=subprocess.run(args,text=True,capture_output=True,timeout=120)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout,time.perf_counter()-t
def sql(q):return run(['psql',*BASE,'-d',DB,'-X','-v','ON_ERROR_STOP=1','-Atq','-c',q])[0].strip()
def file(path):
 r=subprocess.run(['psql',*BASE,'-d',DB,'-X','-v','ON_ERROR_STOP=1','-q','-f',str(path)],text=True,capture_output=True,timeout=120)
 (OUT/(path.name+'.log')).write_text(r.stdout+r.stderr)
 if r.returncode:raise RuntimeError(f'{path.name} falló; ver log')
def snapshot():
 result={}
 for table,cols in {'tenant':'id,nombre','unidad':'id,tenant_id,numero_economico','operador':'id,tenant_id,nombre,telefono','viaje':'id,tenant_id,operador_id,unidad_id,estatus,aceptado_en','gasto':'id,tenant_id,viaje_id,concepto,monto,fecha,img_hash'}.items():
  result[table]=json.loads(sql(f"select json_build_object('count',count(*),'checksum',md5(string_agg(md5(row_to_json(x)::text),'' order by id))) from(select {cols} from public.{table})x"))
 return result
run(['createdb',*BASE,DB]);file(ROOT/'supabase/pruebas-aislamiento/andamio_ci.sql')
files=sorted((ROOT/'supabase/migrations').glob('*.sql'))
beforefiles=[f for f in files if int(f.name[:4])<=303]
afterfiles=[f for f in files if 303<int(f.name[:4])<=339]
start=time.perf_counter()
for f in beforefiles:file(f)
base_secs=time.perf_counter()-start
print(f'BASE0303 {len(beforefiles)} migraciones',flush=True)
sql("insert into tenant(id,nombre) values(md5('upgrade-innovativos')::uuid,'SINTETICO UPGRADE INNOVATIVOS');")
sql("""insert into unidad(id,tenant_id,numero_economico) select md5('up-unit-'||g)::uuid,md5('upgrade-innovativos')::uuid,'UP-'||g from generate_series(1,800)g;
insert into operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) select md5('up-op-'||g)::uuid,md5('upgrade-innovativos')::uuid,'SINTETICO OP '||g,'529335'||lpad(g::text,9,'0'),'2026-01-01' from generate_series(1,800)g;""")
for start in range(1,15001,250):
 sql(f"""insert into viaje(id,tenant_id,operador_id,unidad_id,estatus,avisado_en,aceptado_en)
 select md5('up-trip-'||g)::uuid,md5('upgrade-innovativos')::uuid,md5('up-op-'||(1+(g-1)%800))::uuid,md5('up-unit-'||(1+(g-1)%800))::uuid,'liquidado',
 '2026-08-01T12:00:00Z'::timestamptz+((g-1)/800)*interval '1 day','2026-08-01T12:05:00Z'::timestamptz+((g-1)/800)*interval '1 day' from generate_series({start},{min(start+249,15000)})g;""")
for start in range(1,45001,500):
 sql(f"""insert into gasto(id,tenant_id,viaje_id,concepto,monto,fecha,img_hash)
 select md5('up-doc-'||g)::uuid,md5('upgrade-innovativos')::uuid,md5('up-trip-'||(1+(g-1)%15000))::uuid,'diesel',123.45,'2026-08-01',md5('up-hash-'||g) from generate_series({start},{min(start+499,45000)})g;""")
before=snapshot();(OUT/'before.json').write_text(json.dumps(before,indent=2))
start=time.perf_counter();durations=[]
for f in afterfiles:
 t=time.perf_counter()
 if f.name.startswith('0332_'):file(ROOT/'scripts/ci/0335_preflight_retencion_indices.sql')
 file(f);durations.append({'file':f.name,'seconds':time.perf_counter()-t,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
after=snapshot();(OUT/'after.json').write_text(json.dumps(after,indent=2));assert before==after,(before,after)
report={'db':DB,'recorded_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baseline_migrations':len(beforefiles),'baseline_seconds':base_secs,'upgrade_migrations':len(afterfiles),'upgrade_seconds':time.perf_counter()-start,'durations':durations,'core_data_preserved':True,'scope':'local current migration history through0303, synthetic data; not a production clone or drift validation'}
(OUT/'result.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2));print('UPGRADE_SYNTHETIC_0303_0339_PASS')
