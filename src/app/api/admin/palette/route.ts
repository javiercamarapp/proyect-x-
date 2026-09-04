import { NextResponse } from 'next/server';
import { sesionSuperadmin } from '@/lib/auth/api-superadmin';
import { listarInterruptores, apagar, encender } from '@/lib/likida/interruptores';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { DatoInvalido } from '@/lib/likida/errores';
import { logger } from '@/lib/logger';
import { vieneDeNuestroSitio } from '@/lib/auth/csrf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ═══════════════════════════════════════════════════════════════════════════
// EL BACKEND DEL ⌘K — los datos (interruptores + flotas) y las dos acciones
// (apagar/encender) que el command palette necesita.
//
// ES UNA RUTA Y NO UN SERVER ACTION POR DÓNDE VIVE EL LLAMADOR: el palette
// (command-palette.tsx) se monta en el chrome de /admin, no dentro de una
// página con formulario — un route handler con fetch es el camino idiomático
// para un componente global que necesita datos al abrirse y acciones al
// confirmar. La lógica NO vive aquí: vive en lib/likida/interruptores.ts, la
// misma que usan los server actions de /admin/observabilidad — dos puertas,
// un solo mecanismo, una sola bitácora.
//
// LA PUERTA SE RE-CHEQUEA AQUÍ: las rutas /api no pasan por el layout de
// /admin, así que este archivo es su propia puerta. Sin sesión: 401. Con
// sesión de otro rol: 403. Ninguna de las dos dice qué hay detrás.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET() {
  const { error: puerta, sesion } = await sesionSuperadmin();
  if (!sesion) return puerta;

  try {
    const interruptores = await listarInterruptores();
    // Las flotas para "Ver como flota…". `.limit(200)` dicho: hoy son
    // unidades; si algún día son más de 200, el palette necesitará búsqueda
    // del lado del servidor, no una lista más larga.
    const { data, error } = await supabaseAdmin()
      .from('tenant')
      .select('id, nombre')
      .order('nombre')
      .limit(200);
    if (error) throw new Error(`palette.flotas: ${error.message}`);

    return NextResponse.json({
      interruptores: interruptores.map((i) => ({ id: i.id, apagado: i.apagado, motivo: i.motivo })),
      flotas: ((data ?? []) as Array<{ id: string; nombre: string }>).map((f) => ({ id: f.id, nombre: f.nombre })),
    });
  } catch (e) {
    // El error se DICE (500 con texto genérico) y se loguea completo: el
    // palette enseña "no se pudo leer", nunca una lista vacía que afirme que
    // no hay flotas ni interruptores.
    logger.error('palette.lectura_fallo', { err: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: 'No se pudieron leer los datos del buscador.' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  // ── DE DÓNDE VIENE, ANTES DE QUIÉN ES (auditoría prod, SEG-9) ───────────
  //
  // Esta ruta APAGA INTERRUPTORES: el kill switch global, el de WhatsApp, el
  // de facturación. Se autentica con la cookie de sesión, así que sin esta
  // comprobación una página cualquiera que Javier tuviera abierta podía
  // pedirle al navegador que apagara el sistema en su nombre. `sameSite: lax`
  // lo mitiga; esta línea lo decide. Va ANTES de mirar la sesión a propósito:
  // a una petición de otro sitio no se le contesta si el usuario es
  // superadmin o no.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('palette.origen_ajeno', {
      origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site'),
    });
    return NextResponse.json({ error: 'Petición de otro sitio.' }, { status: 403 });
  }

  const { error: puerta, sesion } = await sesionSuperadmin();
  if (!sesion) return puerta;

  let cuerpo: { operacion?: string; id?: string; motivo?: string };
  try {
    cuerpo = await req.json() as typeof cuerpo;
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 });
  }

  const { operacion, id, motivo } = cuerpo;
  if (!id || (operacion !== 'apagar' && operacion !== 'encender')) {
    return NextResponse.json({ error: 'Falta el interruptor o la operación no existe.' }, { status: 400 });
  }

  try {
    if (operacion === 'apagar') await apagar(id, motivo ?? '', sesion.userId);
    else await encender(id, sesion.userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // `DatoInvalido` se enseña verbatim (está escrito para la persona);
    // cualquier otro error se loguea y se dice en genérico — el mensaje de
    // Postgres no le sirve a nadie en un palette y sí describe el esquema.
    if (e instanceof DatoInvalido) return NextResponse.json({ error: e.message }, { status: 400 });
    logger.error('palette.interruptor_fallo', { operacion, interruptor: id, err: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: `No se pudo ${operacion} el interruptor. El detalle quedó en los registros.` }, { status: 500 });
  }
}
