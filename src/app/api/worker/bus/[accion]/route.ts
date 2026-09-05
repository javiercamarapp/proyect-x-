import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
// ═══════════════════════════════════════════════════════════════════════════
// LA API DEL BUS PARA WORKERS (0135) — el reemplazo del service role en la
// Mac. Cada acción exige SU capacidad; el resolver falla cerrado y deja
// telemetría. El contrato espeja EXACTAMENTE lo que bus.sh hacía contra
// PostgREST — mismo claim anclado a `pendiente`, mismo upsert sin tocar
// `estado` de una pieza aprobada.
// ═══════════════════════════════════════════════════════════════════════════
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { resolverLlaveWorker, type CapacidadWorker } from '@/lib/worker/llaves';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CAP_POR_ACCION: Record<string, CapacidadWorker> = {
  'corrida-inicio': 'bus.latido',
  'corrida-fin': 'bus.latido',
  'pieza': 'bus.pieza',
  'catalogo': 'bus.catalogo',
  'ordenes': 'bus.ordenes',
  'ordenes-claim': 'bus.ordenes',
  'ordenes-resolver': 'bus.ordenes',
};

/** 3 MiB: base64 y metadatos deben caber en el transporte HTTP; un video no cabe aquí a
 *  propósito (la Mac sube el preview, no el master). */
const TOPE_MEDIA = 3 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ accion: string }> }) {
  const { accion } = await ctx.params;
  const cap = CAP_POR_ACCION[accion];
  if (!cap) return NextResponse.json({ error: 'Acción desconocida.' }, { status: 404 });
  const quien = await resolverLlaveWorker(req.headers.get('x-worker-key'), cap);
  if (!quien.ok) return NextResponse.json({ error: quien.error }, { status: 403 });

  // El cliente envía UTF8 y divide catálogos en lotes bajo los 4.5 MB
  // que la plataforma admite antes de alcanzar este handler.
  const lecturaCuerpo = await leerTextoAcotado(req, 4_400_000);
  if (!lecturaCuerpo.ok) return NextResponse.json({ error: lecturaCuerpo.motivo === 'demasiado_grande' ? 'payload muy grande' : 'JSON inválido' },
    { status: lecturaCuerpo.motivo === 'demasiado_grande' ? 413 : 400 });
  let cuerpo: Record<string, unknown>;
  try {
    const valor: unknown = JSON.parse(lecturaCuerpo.texto);
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return NextResponse.json({ error: 'Se esperaba un objeto JSON.' }, { status: 400 });
    cuerpo = valor as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const camposTexto = accion === 'pieza'
    ? ['rutina', 'carpeta', 'titulo', 'tipo', 'copyMd', 'mediaBase64', 'mediaNombre', 'mediaMime']
    : accion === 'corrida-inicio' ? ['rutina']
      : accion === 'corrida-fin' ? ['id', 'prUrl', 'veredicto']
        : accion === 'ordenes-resolver' ? ['id', 'resultado'] : accion === 'ordenes-claim' ? ['id'] : [];
  if (camposTexto.some((campo) => cuerpo[campo] != null && typeof cuerpo[campo] !== 'string')
      || (accion === 'corrida-fin' && cuerpo.exitCode != null && (typeof cuerpo.exitCode !== 'number' || !Number.isFinite(cuerpo.exitCode)))
      || (accion === 'ordenes-resolver' && cuerpo.ok != null && typeof cuerpo.ok !== 'boolean')) {
    return NextResponse.json({ error: 'Tipos de campos inválidos.' }, { status: 400 });
  }
  const admin = supabaseAdmin();

  try {
    switch (accion) {
      case 'corrida-inicio': {
        const rutina = typeof cuerpo?.rutina === 'string' ? cuerpo.rutina.slice(0, 80) : '';
        if (!rutina) return NextResponse.json({ error: 'Falta rutina.' }, { status: 400 });
        const { data, error } = await admin.from('bus_corrida').insert({ rutina }).select('id').single();
        if (error) throw new Error(error.message);
        return NextResponse.json({ id: data.id });
      }
      case 'corrida-fin': {
        const id = typeof cuerpo?.id === 'string' ? cuerpo.id : '';
        if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'Falta id.' }, { status: 400 });
        // AUDITORÍA 24, BE-22: `.eq('id', id)` a secas re-cerraba una corrida
        // YA cerrada, pisando su `fin`, su `exit_code` y su veredicto con los
        // de una entrega repetida (o los de un worker viejo que revivió con el
        // id en la mano). La bitácora del bus es la única memoria de qué corrió
        // y cómo acabó: se ancla a que siga abierta, como el claim de las
        // órdenes ancla a `pendiente`.
        const { data: cerradas, error } = await admin.from('bus_corrida').update({
          fin: new Date().toISOString(),
          exit_code: typeof cuerpo?.exitCode === 'number' ? cuerpo.exitCode : null,
          pr_url: typeof cuerpo?.prUrl === 'string' ? cuerpo.prUrl.slice(0, 300) : undefined,
          veredicto: typeof cuerpo?.veredicto === 'string' ? cuerpo.veredicto.slice(0, 300) : null,
        }).eq('id', id).is('fin', null).select('id');
        if (error) throw new Error(error.message);
        const cerro = (cerradas ?? []).length === 1;
        if (!cerro) logger.warn('worker.bus.corrida_ya_cerrada', { id, worker: quien.nombre });
        return NextResponse.json({ ok: true, cerro });
      }
      case 'pieza': {
        const carpeta = typeof cuerpo?.carpeta === 'string' ? cuerpo.carpeta.slice(0, 300) : '';
        if (!carpeta) return NextResponse.json({ error: 'Falta carpeta.' }, { status: 400 });
        let mediaPath: string | null = null;
        const b64 = typeof cuerpo?.mediaBase64 === 'string' ? cuerpo.mediaBase64 : null;
        if (b64) {
          if (b64.length > 4 * Math.ceil(TOPE_MEDIA / 3)) return NextResponse.json({ error: 'La vista previa pasa de 3 MB. Reduce la imagen.' }, { status: 413 });
          const media = Buffer.from(b64, 'base64');
          if (media.toString('base64') !== b64) return NextResponse.json({ error: 'La media no es base64 válido.' }, { status: 400 });
          if (media.length > TOPE_MEDIA) return NextResponse.json({ error: 'La vista previa pasa de 3 MB. Reduce la imagen.' }, { status: 413 });
          // El path lo arma el SERVIDOR con la carpeta declarada — el nombre
          // se sanea: un ../ aquí escribiría fuera de piezas/.
          const nombre = String(cuerpo?.mediaNombre ?? 'preview.png').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
          const objeto = `piezas/${carpeta.replace(/\.\./g, '_')}/${nombre}`;
          const up = await admin.storage.from('bus').upload(objeto, media, {
            contentType: typeof cuerpo?.mediaMime === 'string' ? cuerpo.mediaMime : 'application/octet-stream',
            upsert: true,
          });
          if (!up.error) mediaPath = objeto;
          else logger.warn('worker.pieza_media', { err: up.error.message });
        }
        const { error } = await admin.from('bus_pieza').upsert({
          rutina: String(cuerpo?.rutina ?? '').slice(0, 80),
          carpeta,
          titulo: String(cuerpo?.titulo ?? carpeta).slice(0, 200),
          tipo: String(cuerpo?.tipo ?? 'otro').slice(0, 30),
          copy_md: typeof cuerpo?.copyMd === 'string' ? cuerpo.copyMd.slice(0, 4000) : null,
          ...(mediaPath ? { media_path: mediaPath } : {}),
        }, { onConflict: 'carpeta' });
        if (error) throw new Error(error.message);
        return NextResponse.json({ ok: true, mediaPath });
      }
      case 'catalogo': {
        const rutinas = Array.isArray(cuerpo?.rutinas) && cuerpo.rutinas.length <= 50 ? cuerpo.rutinas : null;
        if (!rutinas || rutinas.some((x) => !x || typeof x !== 'object' || Array.isArray(x)
          || ['nombre', 'horario', 'descripcion', 'encargo_md'].some((campo) => {
            const valor = (x as Record<string, unknown>)[campo];
            return valor != null && typeof valor !== 'string';
          }))) return NextResponse.json({ error: 'Rutinas inválidas.' }, { status: 400 });
        const filas = rutinas.map((r) => {
          const x = r as Record<string, unknown>;
          return {
            nombre: String(x.nombre ?? '').slice(0, 80),
            horario: String(x.horario ?? '').slice(0, 120),
            descripcion: String(x.descripcion ?? '').slice(0, 200),
            encargo_md: String(x.encargo_md ?? '').slice(0, 20000),
            actualizado_en: new Date().toISOString(),
          };
        }).filter((f) => f.nombre);
        const { error } = await admin.from('bus_rutina').upsert(filas, { onConflict: 'nombre' });
        if (error) throw new Error(error.message);
        return NextResponse.json({ ok: true, sembradas: filas.length });
      }
      case 'ordenes': {
        const { data, error } = await admin.from('bus_orden')
          .select('id, tipo, rutina, payload, creado_en')
          .eq('estado', 'pendiente').order('creado_en').limit(10);
        if (error) throw new Error(error.message);
        return NextResponse.json({ ordenes: data ?? [] });
      }
      case 'ordenes-claim': {
        const id = typeof cuerpo?.id === 'string' ? cuerpo.id : '';
        if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'Falta id.' }, { status: 400 });
        // El claim anclado a `pendiente` — la atomicidad vive en el WHERE.
        // AUDITORÍA 24, BE-22: se firma QUIÉN la tomó (0285). El nombre sale
        // de la llave con la que ya se autenticó el worker, no del cuerpo:
        // nadie puede reclamar en nombre de otro.
        const { data, error } = await admin.from('bus_orden')
          .update({ estado: 'tomada', tomada_en: new Date().toISOString(), tomada_por: quien.nombre })
          .eq('id', id).eq('estado', 'pendiente').select('id');
        if (error) throw new Error(error.message);
        return NextResponse.json({ tomada: (data ?? []).length === 1 });
      }
      case 'ordenes-resolver': {
        const id = typeof cuerpo?.id === 'string' ? cuerpo.id : '';
        if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'Falta id.' }, { status: 400 });
        // AUDITORÍA 24, BE-22: cerrar exige seguir TOMADA y ser QUIEN la tomó.
        // Sin esto, el worker B marcaba `hecha` la orden de A y `resultado`
        // contaba lo que hizo B sobre el trabajo de A. `tomada_por` es NULL en
        // las órdenes anteriores a la 0285: ahí no se adivina un dueño, queda
        // el ancla por estado (que ya evita el doble cierre).
        const cierre = {
          estado: cuerpo?.ok === true ? 'hecha' : 'fallida',
          resuelta_en: new Date().toISOString(),
          resultado: String(cuerpo?.resultado ?? '').slice(0, 400) || 'sin detalle',
        };
        const mio = await admin.from('bus_orden').update(cierre)
          .eq('id', id).eq('estado', 'tomada').eq('tomada_por', quien.nombre).select('id');
        if (mio.error) throw new Error(mio.error.message);
        let resolvio = (mio.data ?? []).length === 1;
        if (!resolvio) {
          // Órdenes anteriores a la 0285: sin dueño guardado. No se les inventa
          // uno; queda el ancla por estado, que ya evita el doble cierre.
          const vieja = await admin.from('bus_orden').update(cierre)
            .eq('id', id).eq('estado', 'tomada').is('tomada_por', null).select('id');
          if (vieja.error) throw new Error(vieja.error.message);
          resolvio = (vieja.data ?? []).length === 1;
        }
        // Un cierre que no aplicó NO es 200 a secas: quien lo mandó cree que
        // dejó constancia. Se dice por valor y se nombra en el log.
        if (!resolvio) logger.warn('worker.bus.orden_ajena_o_cerrada', { id, worker: quien.nombre });
        return NextResponse.json({ ok: true, resolvio });
      }
    }
    return NextResponse.json({ error: 'Acción desconocida.' }, { status: 404 });
  } catch (e) {
    logger.error('worker.bus', { accion, worker: quien.nombre, err: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: 'La operación no se pudo completar.' }, { status: 500 });
  }
}
