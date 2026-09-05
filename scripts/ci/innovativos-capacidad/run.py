#!/usr/bin/env python3
"""Capacidad SQL sintética; SOLO cluster local de auditoría y bases propias.
No certifica API/Storage/OCR, proveedores, capacidad mensual ni RTO productivo.
"""
from pathlib import Path
import argparse, concurrent.futures, datetime, hashlib, json, math, os, re, shutil, signal, stat, subprocess, time
from continuity import acceptance, continuity, gap_reason

HOST='/private/tmp/likida-db-r3.d0fCDX'
PORT='55501'
ROOT=Path(__file__).resolve().parent
p=argparse.ArgumentParser()
p.add_argument('action',choices=['seed','bench','explain','fairness','restore','soak','summary'])
p.add_argument('--db',required=True)
p.add_argument('--host',default=HOST,help='Directorio de socket UNIX local; no TCP')
p.add_argument('--port',type=int,default=int(PORT))
p.add_argument('--template',default='likida_sql339_root',help='Base local plantilla 0339, sólo para seed')
p.add_argument('--out',type=Path,required=True)
p.add_argument('--seconds',type=int,default=86400)
p.add_argument('--rate',type=float,default=2.0)
a=p.parse_args()
if not Path(a.host).is_absolute() or not 1<=a.port<=65535:
 p.error('Host debe ser ruta absoluta UNIX y puerto válido')
socket=Path(a.host)/f'.s.PGSQL.{a.port}'
if not socket.exists() or not stat.S_ISSOCK(socket.stat().st_mode):
 p.error('Se exige socket PostgreSQL UNIX local existente; TCP remoto prohibido')
HOST=a.host;PORT=str(a.port)
if not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*',a.template):p.error('Nombre de plantilla inválido')
if not re.fullmatch(r'innovativos_cap_[a-z0-9_]+',a.db): p.error('DB debe usar prefijo propio innovativos_cap_')
if a.seconds<1 or a.seconds>86400 or not 0<a.rate<=5: p.error('Duración 1..86400; tasa >0 y <=5')
a.out.mkdir(parents=True,exist_ok=True)
BASE=['-h',HOST,'-p',PORT]
ENV={**os.environ,'PGOPTIONS':'-c statement_timeout=30000 -c lock_timeout=5000','PGAPPNAME':'innovativos_cap_harness'}
def cmd(args,timeout=600):
 t=time.perf_counter();r=subprocess.run(args,text=True,capture_output=True,env=ENV,timeout=timeout)
 if r.returncode: raise RuntimeError(f'{args[0]} rc={r.returncode}: {r.stderr[-5000:]} {r.stdout[-2000:]}')
 return r.stdout,time.perf_counter()-t
def sql(q,db=None):return cmd(['psql',*BASE,'-d',db or a.db,'-X','-v','ON_ERROR_STOP=1','-Atq','-c',q])[0].strip()
def save(name,data): (a.out/name).write_text(json.dumps(data,indent=2) if not isinstance(data,str) else data)
def guard():
 assert sql("select label from innovativos_cap_harness.owner where id=1")=='synthetic-only-0339', 'No existe marcador de propiedad'
def uid(kind,n): return hashlib.md5(f'innovativos-cap-{kind}-{n}'.encode()).hexdigest()
def tid(n):return f"md5('innovativos-cap-tenant-{n}')::uuid"
def snapshots():
 result={}
 for table in ['tenant','app_user','unidad','operador','viaje','gasto','comprobante_huerfano']:
  where="nombre like 'SINTETICO INNOVATIVOS CAP %'" if table=='tenant' else "tenant_id in(select id from public.tenant where nombre like 'SINTETICO INNOVATIVOS CAP %')"
  # Hash de TODAS las columnas por fila y orden estable, no solo IDs.
  result[table]=json.loads(sql(f"select json_build_object('count',count(*),'checksum',md5(coalesce(string_agg(md5(row_to_json(x)::text),'' order by id),''))) from(select * from public.{table} where {where})x"))
 return result
def rls(db):
 results=[]
 for n in range(1,6):
  units=800 if n==1 else 1050;trips=15000 if n==1 else 8750
  q=f"""begin; set local role authenticated; select set_config('request.jwt.claims',json_build_object('sub',md5('innovativos-cap-user-{n}')::uuid,'role','authenticated')::text,true);
  do $$declare u int;v int;g int;l int;begin
  select count(*) into u from public.unidad; select count(*) into v from public.viaje;select count(*) into g from public.gasto;
  select count(*) into l from public.gasto where tenant_id<>{tid(n)};
  if u<>{units} or v<>{trips} or g<>{trips*3} or l<>0 then raise exception 'RLS incorrecta: %,%,%,%',u,v,g,l;end if;end$$;rollback;"""
  sql(q,db);results.append({'tenant':n,'units':units,'trips':trips,'documents':trips*3,'foreign_documents':0})
 return results
if a.action=='seed':
 t=time.perf_counter();cmd(['createdb',*BASE,'-T',a.template,a.db])
 assert sql("select count(*) from pg_constraint where conname='jornada_trabajo_operador_tenant_fkey'")=='1'
 sql("create schema innovativos_cap_harness; create table innovativos_cap_harness.owner(id int primary key,label text); insert into innovativos_cap_harness.owner values(1,'synthetic-only-0339');")
 sql("""insert into public.tenant(id,nombre,zona_horaria) select md5('innovativos-cap-tenant-'||g)::uuid,'SINTETICO INNOVATIVOS CAP '||g,'America/Mexico_City' from generate_series(1,5)g;
 insert into public.app_user(id,tenant_id,email,nombre,rol) select md5('innovativos-cap-user-'||g)::uuid,md5('innovativos-cap-tenant-'||g)::uuid,'innovativos-cap-'||g||'@example.invalid','SINTETICO','flota_admin' from generate_series(1,5)g;""")
 for tenant in range(1,6):
  units=800 if tenant==1 else 1050;trips=15000 if tenant==1 else 8750
  sql(f"""insert into public.unidad(id,tenant_id,numero_economico) select md5('innovativos-cap-unit-{tenant}-'||g)::uuid,{tid(tenant)},'CAP-{tenant}-'||g from generate_series(1,{units})g;
  insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) select md5('innovativos-cap-op-{tenant}-'||g)::uuid,{tid(tenant)},'SINTETICO OP '||g,'529331{tenant}'||lpad(g::text,8,'0'),'2026-01-01' from generate_series(1,{units})g;""")
  for start in range(1,trips+1,250):
   end=min(start+249,trips)
   sql(f"""insert into public.viaje(id,tenant_id,operador_id,unidad_id,estatus,avisado_en,aceptado_en)
   select md5('innovativos-cap-trip-{tenant}-'||g)::uuid,{tid(tenant)},md5('innovativos-cap-op-{tenant}-'||(1+(g-1)%{units}))::uuid,md5('innovativos-cap-unit-{tenant}-'||(1+(g-1)%{units}))::uuid,
   'liquidado','2026-08-01T12:00:00Z'::timestamptz+((g-1)/{units})*interval '1 day','2026-08-01T12:05:00Z'::timestamptz+((g-1)/{units})*interval '1 day' from generate_series({start},{end})g;""")
  for start in range(1,trips*3+1,500):
   end=min(start+499,trips*3)
   sql(f"""insert into public.gasto(id,tenant_id,viaje_id,concepto,monto,fecha,folio,imagen_url,ocr_raw,img_hash,created_at)
   select md5('innovativos-cap-doc-{tenant}-'||g)::uuid,{tid(tenant)},md5('innovativos-cap-trip-{tenant}-'||(1+(g-1)%{trips}))::uuid,
   case g%3 when 0 then 'diesel' when 1 then 'caseta' else 'alimentacion' end,123.45,'2026-08-01','SINTETICO-'||g,
   'synthetic://metadata-only/{tenant}/'||g||'.jpg',jsonb_build_object('synthetic',true,'text',repeat('SINTETICO ',100)),md5('innovativos-cap-img-{tenant}-'||g),
   '2026-08-01T12:00:00Z'::timestamptz+(g%2592000)*interval '1 second' from generate_series({start},{end})g;""")
  print(f'seed tenant {tenant}: {units} units, {trips} trips, {trips*3} documents',flush=True)
 sql('analyze public.viaje; analyze public.gasto; analyze public.unidad; analyze public.operador;')
 save('seed.json',{'seconds':time.perf_counter()-t,'db':a.db,'counts':snapshots(),'rls':rls(a.db),'db_bytes':int(sql('select pg_database_size(current_database())')),'schema':'0339','image_bytes':0,'ocr_calls':0})
 print('SEED_PASS',flush=True)
else:guard()
if a.action=='explain':
 queries={
 'paginacionGasto':f"select id from public.gasto where tenant_id={tid(1)} order by id limit 1000 offset 1000",
 'paginacionGastoUltima':f"select id from public.gasto where tenant_id={tid(1)} order by id limit 1000 offset 44000",
 'paginacionViaje':f"select id from public.viaje where tenant_id={tid(1)} order by id limit 1000 offset 500",
 'paginacionHuerfano':f"select resuelto_en from public.comprobante_huerfano where tenant_id={tid(1)} order by id limit 1000",
 'viajeReciente':f"select id,folio,estatus from public.viaje where tenant_id={tid(1)} order by created_at desc limit 100",
 'getDocumentos':f"select id,concepto,monto,fecha,folio,rfc_emisor,cfdi_uuid,estado_sat,ocr_confianza,efos,xml_verificado,imagen_url from public.gasto where tenant_id={tid(1)} order by created_at desc limit 100",
 'gastoExistePorHash':f"select id from public.gasto where tenant_id={tid(1)} and viaje_id=md5('innovativos-cap-trip-1-1')::uuid and img_hash=md5('innovativos-cap-img-1-1') limit 1",
 'getHuerfanos':f"select id,gasto,motivo,creado_en,ruta_imagen,ofrecido_en from public.comprobante_huerfano where tenant_id={tid(1)} and operador_id=md5('innovativos-cap-op-1-1')::uuid and resuelto_en is null order by creado_en asc limit 50",
 'viajesUnidadDia':f"select id from public.viaje where tenant_id={tid(1)} and unidad_id=md5('innovativos-cap-unit-1-1')::uuid and aceptado_en>='2026-08-01T00:00:00Z' and aceptado_en<'2026-08-02T00:00:00Z'",
 }
 for name,q in queries.items():save(name+'.explain.json',json.loads(sql('explain (analyze,buffers,format json) '+q)))
 save('query-source-map.json',{'getDocumentos':'src/lib/likida/analytics.ts:getDocumentos','gastoExistePorHash':'src/lib/likida/repo.ts:gastoExistePorHash','getHuerfanos':'src/lib/likida/repo.ts:getHuerfanos','viajesUnidadDia':'reclamar_jornadas_por_derivar: GPS exclusividad de unidad/dia (consulta base)'})
 print('EXPLAIN_SAVED')
if a.action=='bench':
 # 10 clientes * 2500 transacciones = exactamente 25k metadatos. Sin bytes/OCR.
 prefix=a.out/'burst';args=['pgbench',*BASE,'-d',a.db,'-n','-c','10','-j','2','-t','2500','-f',str(ROOT/'burst.sql'),'-l','--log-prefix',str(prefix),'--max-tries','1','--exit-on-abort','--random-seed','20260904']
 output,elapsed=cmd(args,timeout=600);save('burst.stdout',output)
 logs=list(a.out.glob('burst.*'));lat=[]
 for path in logs:
  if not path.name.rsplit('.',1)[-1].isdigit():continue
  for line in path.read_text().splitlines():
   cols=line.split()
   if len(cols)>2 and cols[2].isdigit():lat.append(int(cols[2])/1000)
 lat.sort()
 def pct(q):return lat[max(0,math.ceil(len(lat)*q)-1)] if lat else None
 counts=json.loads(sql("select json_object_agg(tenant_id,n) from(select tenant_id,count(*)n from public.comprobante_huerfano where gasto->>'harness'='innovativos-cap-burst' group by tenant_id)x"))
 save('burst.json',{'transactions':len(lat),'elapsed_seconds':elapsed,'p50_ms':pct(.5),'p95_ms':pct(.95),'p99_ms':pct(.99),'max_ms':max(lat) if lat else None,'tenant_counts':counts,'mode':'10 clients, persistent connections; one metadata insert plus document read per transaction','bytes_uploaded':0,'ocr_calls':0})
 assert len(lat)==25000 and sum(counts.values())==25000,(len(lat),counts)
 assert '0 (0.000%)' in output,output
 sql('analyze public.comprobante_huerfano;')
 print('BURST_25000_PASS')
if a.action=='fairness':
 # Fija fixture SOLO en la DB propia; restaura mediante rollback tras demostrar claims.
 q="""begin;
 update public.jornada_derivacion_trabajo set siguiente_intento_en='infinity';
 insert into public.jornada_derivacion_trabajo(tenant_id,operador_id,dia,viaje_id,unidad_id,unidad_ids,aceptado_en,input_version,viajes_version)
 select v.tenant_id,v.operador_id,'2026-08-01',v.id,v.unidad_id,array[v.unidad_id],v.aceptado_en,'synthetic','synthetic'
 from public.viaje v join public.tenant t on t.id=v.tenant_id where t.nombre like 'SINTETICO INNOVATIVOS CAP %' and v.aceptado_en='2026-08-01T12:05:00Z'
 on conflict(tenant_id,operador_id,dia) do update set siguiente_intento_en='-infinity',claim_token=null,claim_owner=null,lease_expires_at=null,claim_input_version=null;
 create temp table first_claim as select * from public.reclamar_jornadas_por_derivar(10,'synthetic-fairness-1',30);
 create temp table second_claim as select * from public.reclamar_jornadas_por_derivar(10,'synthetic-fairness-2',30);
 do $$declare c int;n int;begin
 select count(*) into c from(select tenant_id,count(*) from first_claim group by tenant_id having count(*)=2)x;
 if c<>5 then raise exception 'first claim unfair, tenants with two=%',c;end if;
 select count(*) into c from(select tenant_id,count(*) from second_claim group by tenant_id having count(*)=2)x;
 if c<>5 then raise exception 'second claim unfair';end if;
 select count(*) into n from first_claim a join second_claim b using(tenant_id,operador_id,dia);
 if n<>0 then raise exception 'overlapping leases';end if;end$$;
 select json_build_object('first', (select json_agg(x) from(select tenant_id,count(*)n from first_claim group by tenant_id)x),'second',(select json_agg(x) from(select tenant_id,count(*)n from second_claim group by tenant_id)x),'overlap',0);
 rollback;"""
 save('fairness.sql',q);save('fairness.json',sql(q));print('FAIRNESS_PASS')
if a.action=='restore':
 target=a.db+'_restored';before=snapshots();save('restore-before.json',before)
 _,dumpsecs=cmd(['pg_dump',*BASE,'-d',a.db,'-Fc','-f',str(a.out/'synthetic.dump')])
 t=time.perf_counter();cmd(['createdb',*BASE,target]);_,restoresecs=cmd(['pg_restore',*BASE,'-d',target,'--exit-on-error',str(a.out/'synthetic.dump')])
 original=a.db;a.db=target;after=snapshots();save('restore-after.json',after);assert before==after
 r=rls(target);a.db=original
 save('restore.json',{'source':original,'target':target,'dump_seconds':dumpsecs,'restore_seconds':restoresecs,'local_create_restore_validate_seconds':time.perf_counter()-t,'dump_bytes':(a.out/'synthetic.dump').stat().st_size,'all_columns_checksums_match':True,'rls':r,'scope':'same warm local disk/cluster; logical snapshot, no PITR/offsite or Storage blobs'})
 print('RESTORE_PASS')
if a.action=='soak':
 # Finito, 24h reales por defecto; límites de tasa/duración verificados arriba.
 baseline=int(sql('select pg_database_size(current_database())'));stop=a.out/'STOP'
 if stop.exists():raise RuntimeError('STOP ya existe; usa otro out o revísalo manualmente')
 args=['pgbench',*BASE,'-d',a.db,'-n','-c','5','-j','2','-T',str(a.seconds),'-R',str(a.rate),'-f',str(ROOT/'read.sql')+'@8','-f',str(ROOT/'update.sql')+'@1','-f',str(ROOT/'soak-insert.sql')+'@1','-l','--log-prefix',str(a.out/'soak'),'-P','30','--max-tries','1','--exit-on-abort','--random-seed','20260904']
 childenv={**ENV,'PGOPTIONS':'-c statement_timeout=2000 -c lock_timeout=1000','PGAPPNAME':'innovativos_cap_soak'}
 with (a.out/'soak.stdout').open('w') as log:
  start=time.time();last_sample=start
  proc=subprocess.Popen(args,stdout=log,stderr=subprocess.STDOUT,env=childenv)
  save('soak-process.json',{'pid':proc.pid,'runner_pid':os.getpid(),'start_epoch':start,'start_utc':datetime.datetime.fromtimestamp(start,datetime.timezone.utc).isoformat(),'duration_seconds':a.seconds,'target_tps':a.rate,'db':a.db,'stop_file':str(stop),'baseline_db_bytes':baseline})
  reason='completed'
  try:
   while proc.poll() is None:
    interruption=gap_reason(last_sample,time.time())
    if interruption:reason=interruption;proc.send_signal(signal.SIGINT);break
    if stop.exists():reason='stop-file';proc.send_signal(signal.SIGINT);break
    stat=json.loads(sql("select json_build_object('db_bytes',pg_database_size(current_database()),'backends',(select count(*) from pg_stat_activity where datname=current_database()),'lock_waiters',(select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock'),'oldest_lock_seconds',(select coalesce(max(extract(epoch from(clock_timestamp()-query_start))),0) from pg_stat_activity where datname=current_database() and wait_event_type='Lock'),'deadlocks',(select deadlocks from pg_stat_database where datname=current_database()),'jornada_backlog',(select count(*) from public.jornada_derivacion_trabajo where claim_token is null and siguiente_intento_en<=clock_timestamp()))"))
    stat.update({'epoch':time.time(),'elapsed_seconds':time.time()-start,'disk_free':shutil.disk_usage(a.out).free})
    with (a.out/'soak-telemetry.jsonl').open('a') as f:f.write(json.dumps(stat)+'\n')
    interruption=gap_reason(last_sample,stat['epoch'])
    last_sample=stat['epoch']
    if interruption:reason=interruption;proc.send_signal(signal.SIGINT);break
    if stat['db_bytes']>baseline*2+512*1024**2 or stat['disk_free']<5*1024**3 or stat['oldest_lock_seconds']>5:
     reason='resource-limit';proc.send_signal(signal.SIGINT);break
    # Wait in 1s steps: stop file response under one second; no scheduler needed.
    for _ in range(30):
     if stop.exists() or proc.poll() is not None or gap_reason(last_sample,time.time()):break
     time.sleep(1)
   try:proc.wait(timeout=15)
   except subprocess.TimeoutExpired:proc.terminate();proc.wait(timeout=15)
  finally:
   if proc.poll() is None:proc.terminate();proc.wait(timeout=15)
  end=time.time()
  # pgbench may finish while the host sleeps; inspect the final unsampled edge too.
  interruption=gap_reason(last_sample,end)
  if reason=='completed' and interruption:reason=interruption
  save('soak-finished.json',{'reason':reason,'exit_code':proc.returncode,'end_epoch':end,'end_utc':datetime.datetime.fromtimestamp(end,datetime.timezone.utc).isoformat(),'elapsed_seconds':end-start,'requested_seconds':a.seconds,'completed_full_duration':reason=='completed' and proc.returncode==0 and end-start>=a.seconds})
 print('SOAK_FINISHED')
if a.action=='summary':
 values=[];failures=0
 for path in a.out.glob('soak.*'):
  if not path.name.rsplit('.',1)[-1].isdigit():continue
  for line in path.read_text().splitlines():
   c=line.split()
   if len(c)>2:
    if c[2].isdigit():values.append(int(c[2])/1000)
    else:failures+=1
 values.sort()
 telepath=a.out/'soak-telemetry.jsonl'
 tele=[json.loads(x) for x in telepath.read_text().splitlines()] if telepath.exists() else []
 def pct(q):return values[max(0,math.ceil(len(values)*q)-1)] if values else None
 finished=json.loads((a.out/'soak-finished.json').read_text()) if (a.out/'soak-finished.json').exists() else {'completed_full_duration':False,'reason':'running'}
 process=json.loads((a.out/'soak-process.json').read_text())
 start_epoch=process.get('start_epoch',datetime.datetime.fromisoformat(process['start_utc']).timestamp())
 end_epoch=finished.get('end_epoch',start_epoch+finished['elapsed_seconds'] if 'elapsed_seconds' in finished else time.time())
 summary={'successful_transactions':len(values),'failed_transactions':failures,'p50_ms':pct(.5),'p95_ms':pct(.95),'p99_ms':pct(.99),'max_ms':max(values) if values else None,'max_lock_waiters':max((x['lock_waiters'] for x in tele),default=None),'max_lock_wait_seconds':max((x['oldest_lock_seconds'] for x in tele),default=None),'database_growth_bytes':tele[-1]['db_bytes']-tele[0]['db_bytes'] if tele else None,'deadlocks_delta':tele[-1]['deadlocks']-tele[0]['deadlocks'] if tele else None,'finished':finished,'telemetry_continuity':continuity(start_epoch,[x['epoch'] for x in tele],end_epoch)}
 summary['local_sql_acceptance']=acceptance(summary,process['duration_seconds'],process['target_tps'])
 save('soak-summary.json',summary);print(json.dumps(summary,indent=2))
