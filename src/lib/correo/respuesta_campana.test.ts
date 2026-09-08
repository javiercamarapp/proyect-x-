import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// LA RESPUESTA DE CAMPAÑA (c5-2): la promesa «responde BAJA» tiene que ser
// verdad — la BAJA suprime, la respuesta detiene al SDR (historial 0118) y
// el operador se entera. Antes NADA de esto existía: el webhook descartaba
// la respuesta como sin_buzon y el pie era mentira.
// ═══════════════════════════════════════════════════════════════════════════

const respuestas = new Map<string, Array<{ data: unknown; error: { message: string } | null }>>();
const inserts: Array<{ tabla: string; payload: Record<string, unknown> }> = [];
const updates: Array<{ tabla: string; payload: Record<string, unknown>; filtros: Record<string, unknown> }> = [];
const deletes: Array<{ tabla: string; filtros: Record<string, unknown> }> = [];

function builder(tabla: string) {
  const responder = () => {
    const cola = respuestas.get(tabla);
    return cola && cola.length > 0 ? cola.shift()! : { data: [], error: null };
  };
  const filtros: Record<string, unknown> = {};
  let op: 'select' | 'update' | 'delete' = 'select';
  let payload: Record<string, unknown> | undefined;
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b,
    eq: (k: string, v: unknown) => { filtros[k] = v; return b; },
    ilike: (k: string, v: unknown) => { filtros[k] = v; return b; },
    is: (k: string, v: unknown) => { filtros[k] = v; return b; },
    or: () => b,
    limit: () => b,
    insert: (p: Record<string, unknown>) => { inserts.push({ tabla, payload: p }); return b; },
    update: (p: Record<string, unknown>) => { op = 'update'; payload = p; return b; },
    delete: () => { op = 'delete'; return b; },
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(() => {
        if (op === 'update') updates.push({ tabla, payload: payload!, filtros: { ...filtros } });
        if (op === 'delete') deletes.push({ tabla, filtros: { ...filtros } });
        return responder();
      }).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));
const suprimir = vi.fn(async () => {});
vi.mock('@/lib/likida/agentes/enviador', () => ({ suprimirCorreo: (...a: unknown[]) => suprimir(...(a as [])) }));
const alertas: Array<{ evento: string }> = [];
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: async (evento: string) => { alertas.push({ evento }); } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const {
  esBaja, extraerCorreo, esRespuestaACampana, procesarRespuestaCampana,
  borrarDatosPersonaPorBaja, borrarDatosPersonaPorBajaPorCorreo,
} = await import('./respuesta_campana');

beforeEach(() => {
  respuestas.clear(); inserts.length = 0; updates.length = 0; deletes.length = 0;
  alertas.length = 0; suprimir.mockClear();
});

describe('los detectores puros', () => {
  it('BAJA es palabra completa, con o sin texto alrededor, sin importar mayúsculas', () => {
    expect(esBaja('BAJA', null)).toBe(true);
    expect(esBaja(null, 'necesito darme de baja por favor')).toBe(true);
    expect(esBaja('Re: propuesta', 'unsubscribe')).toBe(true);
    expect(esBaja('Re: propuesta', 'aquí se trabaja duro')).toBe(false);
    expect(esBaja('rebaja de precios', 'me interesa la rebaja')).toBe(false);
  });
  it('extraerCorreo lee "Nombre <a@b>" y direcciones pelonas', () => {
    expect(extraerCorreo('Juan Pérez <juan@x.mx>')).toBe('juan@x.mx');
    expect(extraerCorreo('MAYUS@X.MX')).toBe('mayus@x.mx');
    expect(extraerCorreo('sin correo')).toBeNull();
  });
  it('esRespuestaACampana matchea el buzón avisos@ del dominio', () => {
    expect(esRespuestaACampana(['Likida <avisos@mail.likida.ai>'], 'avisos@mail.likida.ai')).toBe(true);
    expect(esRespuestaACampana(['facturas+tok@mail.likida.ai'], 'avisos@mail.likida.ai')).toBe(false);
  });
});

describe('procesarRespuestaCampana', () => {
  it('la BAJA suprime SIEMPRE — incluso sin prospecto que la matchee', async () => {
    respuestas.set('prospecto', [{ data: [], error: null }]);
    respuestas.set('prospecto_correo', [{ data: [], error: null }]);
    const r = await procesarRespuestaCampana({ from: 'x@empresa.mx', subject: 'BAJA', text: '' });
    expect(r).toMatchObject({ ok: true, resultado: 'baja_sin_prospecto' });
    expect(suprimir).toHaveBeenCalledWith('x@empresa.mx', expect.stringMatching(/baja/i));
  });

  it('una respuesta registra direccion=respuesta en el historial (el freno del SDR) y alerta al operador', async () => {
    respuestas.set('prospecto', [{ data: [{ id: 'pr-1' }], error: null }]);
    respuestas.set('prospecto_contacto', [{ data: null, error: null }]);
    const r = await procesarRespuestaCampana({ from: 'Gerente <g@empresa.mx>', subject: 'Me interesa', text: 'cuéntame más' });
    expect(r).toMatchObject({ ok: true, resultado: 'respuesta_registrada' });
    expect(suprimir).not.toHaveBeenCalled();
    const contacto = inserts.find((i) => i.tabla === 'prospecto_contacto');
    expect(contacto?.payload).toMatchObject({ prospecto_id: 'pr-1', direccion: 'respuesta', canal: 'correo' });
    expect(alertas.some((a) => a.evento === 'campania.respuesta')).toBe(true);
  });

  it('el remitente que era una COPIA (prospecto_correo) también encuentra su prospecto', async () => {
    respuestas.set('prospecto', [{ data: [], error: null }]);
    respuestas.set('prospecto_correo', [{ data: [{ prospecto_id: 'pr-7' }], error: null }]);
    respuestas.set('prospecto_contacto', [{ data: null, error: null }]);
    const r = await procesarRespuestaCampana({ from: 'compras@empresa.mx', subject: 'BAJA ya', text: '' });
    expect(r).toMatchObject({ ok: true, resultado: 'baja_registrada' });
    expect(inserts[0]?.payload).toMatchObject({ prospecto_id: 'pr-7' });
  });

  it('el historial que no se puede escribir devuelve ok:false — el llamador contesta 503 y el proveedor reintenta', async () => {
    respuestas.set('prospecto', [{ data: [{ id: 'pr-1' }], error: null }]);
    respuestas.set('prospecto_contacto', [{ data: null, error: { message: 'base caída' } }]);
    const r = await procesarRespuestaCampana({ from: 'g@empresa.mx', subject: 'hola', text: '' });
    expect(r.ok).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AUDITORÍA 25, ALTO (línea 89): "Contesta BAJA y se borran tus datos" no
  // borraba nada, y el historial que SÍ escribía reiniciaba el reloj de 365
  // días de `purgar_prospecto_persona` — ejercer el derecho alargaba la
  // retención en vez de acortarla.
  // ═══════════════════════════════════════════════════════════════════════

  it('una BAJA con contacto de cabecera borra prospecto_persona y prospecto_correo, y anonimiza el prospecto', async () => {
    respuestas.set('prospecto', [{ data: [{ id: 'pr-1' }], error: null }]);
    respuestas.set('prospecto_contacto', [{ data: null, error: null }]);
    await procesarRespuestaCampana({ from: 'Laura <laura@transportesdelnorte.mx>', subject: 'BAJA', text: '' });

    const borraPersona = deletes.find((d) => d.tabla === 'prospecto_persona');
    expect(borraPersona?.filtros).toMatchObject({ prospecto_id: 'pr-1', correo: 'laura@transportesdelnorte.mx' });
    const borraCopia = deletes.find((d) => d.tabla === 'prospecto_correo');
    expect(borraCopia?.filtros).toMatchObject({ prospecto_id: 'pr-1' });
    const anonimiza = updates.find((u) => u.tabla === 'prospecto');
    expect(anonimiza?.filtros).toMatchObject({ id: 'pr-1' });
    expect(anonimiza?.payload).toMatchObject({ contacto_nombre: null, telefono: null, correo: null });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AUDITORÍA 28, LEG-M3 (MEDIO, REINCIDENTE, docs/auditoria-28/legal.md:40):
  // la 25 solo borraba tres de las SEIS tablas que `purgar_prospecto_persona`
  // (0258) ya tenía decidido tocar. Esta sección cubre las tres que faltaban
  // y las dos vías de entrada (respuesta de correo y liga de un clic).
  // ═══════════════════════════════════════════════════════════════════════

  it('LEG-M3: una BAJA de contacto principal completa el inventario de 0258 — borra cola_aprobacion y anonimiza dossier y toque', async () => {
    respuestas.set('prospecto', [{ data: [{ id: 'pr-1' }], error: null }]);
    respuestas.set('prospecto_contacto', [{ data: null, error: null }]);
    await procesarRespuestaCampana({ from: 'Laura <laura@transportesdelnorte.mx>', subject: 'BAJA', text: '' });

    const borraPiezas = deletes.find((d) => d.tabla === 'cola_aprobacion');
    expect(borraPiezas?.filtros).toMatchObject({ prospecto_id: 'pr-1' });
    const anonimizaDossier = updates.find((u) => u.tabla === 'prospecto_dossier');
    expect(anonimizaDossier?.filtros).toMatchObject({ prospecto_id: 'pr-1' });
    expect(anonimizaDossier?.payload).toMatchObject({ telefonos: null, datos: null });
    const anonimizaToque = updates.find((u) => u.tabla === 'prospecto_toque');
    expect(anonimizaToque?.filtros).toMatchObject({ prospecto_id: 'pr-1' });
    expect(anonimizaToque?.payload).toMatchObject({ resumen: null });
  });

  it('una BAJA de un remitente que solo era COPIA no anonimiza el contacto de cabecera ni el dossier, ni borra piezas (son de otra persona) — pero SÍ anonimiza el toque, que es del prospecto', async () => {
    respuestas.set('prospecto', [{ data: [], error: null }]);
    respuestas.set('prospecto_correo', [{ data: [{ prospecto_id: 'pr-7' }], error: null }]);
    respuestas.set('prospecto_contacto', [{ data: null, error: null }]);
    await procesarRespuestaCampana({ from: 'compras@empresa.mx', subject: 'BAJA ya', text: '' });

    expect(deletes.some((d) => d.tabla === 'prospecto_persona' && d.filtros.prospecto_id === 'pr-7')).toBe(true);
    expect(updates.find((u) => u.tabla === 'prospecto')).toBeUndefined();
    expect(updates.find((u) => u.tabla === 'prospecto_dossier')).toBeUndefined();
    expect(deletes.find((d) => d.tabla === 'cola_aprobacion')).toBeUndefined();
    const anonimizaToque = updates.find((u) => u.tabla === 'prospecto_toque');
    expect(anonimizaToque?.filtros).toMatchObject({ prospecto_id: 'pr-7' });
    expect(anonimizaToque?.payload).toMatchObject({ resumen: null });
  });

  it('LEG-M3: el historial de una BAJA no lleva el asunto que la persona escribió — texto fijo "Pidió BAJA"', async () => {
    respuestas.set('prospecto', [{ data: [{ id: 'pr-1' }], error: null }]);
    respuestas.set('prospecto_contacto', [{ data: null, error: null }]);
    await procesarRespuestaCampana({ from: 'g@empresa.mx', subject: 'Ya no me interesa, BAJA por favor', text: '' });

    const contacto = inserts.find((i) => i.tabla === 'prospecto_contacto');
    expect(contacto?.payload.resumen).toBe('Pidió BAJA');
    expect(contacto?.payload.resumen).not.toContain('Ya no me interesa');
  });

  it('una respuesta que NO pide baja SÍ lleva el asunto en el historial (sin cambio de comportamiento)', async () => {
    respuestas.set('prospecto', [{ data: [{ id: 'pr-1' }], error: null }]);
    respuestas.set('prospecto_contacto', [{ data: null, error: null }]);
    await procesarRespuestaCampana({ from: 'g@empresa.mx', subject: 'Me interesa', text: 'cuéntame más' });

    const contacto = inserts.find((i) => i.tabla === 'prospecto_contacto');
    expect(contacto?.payload.resumen).toContain('Me interesa');
  });

  it('LEG-M3: borrarDatosPersonaPorBajaPorCorreo (la liga de un clic) llega a las SEIS tablas igual que la respuesta por correo', async () => {
    respuestas.set('prospecto', [{ data: [{ id: 'pr-9' }], error: null }]);
    await borrarDatosPersonaPorBajaPorCorreo('otra@empresa.mx');

    expect(deletes.some((d) => d.tabla === 'prospecto_persona' && d.filtros.prospecto_id === 'pr-9')).toBe(true);
    expect(deletes.some((d) => d.tabla === 'prospecto_correo' && d.filtros.prospecto_id === 'pr-9')).toBe(true);
    expect(deletes.some((d) => d.tabla === 'cola_aprobacion' && d.filtros.prospecto_id === 'pr-9')).toBe(true);
    expect(updates.some((u) => u.tabla === 'prospecto' && u.filtros.id === 'pr-9')).toBe(true);
    expect(updates.some((u) => u.tabla === 'prospecto_dossier' && u.filtros.prospecto_id === 'pr-9')).toBe(true);
    expect(updates.some((u) => u.tabla === 'prospecto_toque' && u.filtros.prospecto_id === 'pr-9')).toBe(true);
  });

  it('LEG-M3: ninguna de las tres tablas nuevas rompe el mejor esfuerzo — un fallo en cualquiera no lanza', async () => {
    respuestas.set('cola_aprobacion', [{ data: null, error: { message: 'base caída' } }]);
    respuestas.set('prospecto_dossier', [{ data: null, error: { message: 'base caída' } }]);
    respuestas.set('prospecto_toque', [{ data: null, error: { message: 'base caída' } }]);
    await expect(borrarDatosPersonaPorBaja('pr-1', 'x@y.mx', true)).resolves.toBeUndefined();
  });

  it('una respuesta que NO pide baja no borra ni anonimiza nada', async () => {
    respuestas.set('prospecto', [{ data: [{ id: 'pr-1' }], error: null }]);
    respuestas.set('prospecto_contacto', [{ data: null, error: null }]);
    await procesarRespuestaCampana({ from: 'g@empresa.mx', subject: 'Me interesa', text: 'cuéntame más' });
    expect(deletes.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it('borrarDatosPersonaPorBaja nunca lanza aunque una tabla truene — mejor esfuerzo', async () => {
    respuestas.set('prospecto_persona', [{ data: null, error: { message: 'base caída' } }]);
    await expect(borrarDatosPersonaPorBaja('pr-1', 'x@y.mx', true)).resolves.toBeUndefined();
  });

  it('borrarDatosPersonaPorBajaPorCorreo (la liga de un clic) resuelve el prospecto y borra igual', async () => {
    respuestas.set('prospecto', [{ data: [{ id: 'pr-9' }], error: null }]);
    await borrarDatosPersonaPorBajaPorCorreo('otra@empresa.mx');
    const anonimiza = updates.find((u) => u.tabla === 'prospecto');
    expect(anonimiza?.filtros).toMatchObject({ id: 'pr-9' });
  });
});
