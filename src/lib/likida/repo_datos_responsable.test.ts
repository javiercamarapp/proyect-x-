import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 8 · CRÍTICO de pruebas (superviviente de la ronda 6, 3ª ronda sin
// tocar) — `getDatosResponsable` exige la RAZÓN SOCIAL antes de devolver los
// datos; sin esta guarda, `ponerAvisoADisposicion` podría construir un aviso
// sin responsable, y `processInbound` trataría datos personales del operador
// sin que el aviso los ampare de verdad.
//
// AUDITORÍA 19 (legal C3 / C.16): el DOMICILIO dejó de tumbar la lectura.
// Exigirlo aquí hacía 404 la página pública del aviso para toda flota sin la
// columna capturada. La guarda del domicilio para el CANAL sigue viva donde
// corresponde: `avisoSimplificado` devuelve null sin él (art. 15 fr. I) y
// `ponerAvisoADisposicion` responde `sin_datos` — esta prueba fija ese
// reparto para que no se pierda en un refactor.
//
// Mutado a `return r;` (sin la guarda), 1299/1300 pruebas seguían pasando: nada
// llamaba a esta función contra un tenant con razón social vacía.
// ═══════════════════════════════════════════════════════════════════════════

let fila: Record<string, unknown> | null = null;

const from = vi.fn(() => {
  const enlace: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) enlace[m] = () => enlace;
  enlace.maybeSingle = async () => ({ data: fila, error: null });
  return enlace;
});

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { getDatosResponsable } = await import('./repo');
const { avisoSimplificado, avisoIntegral } = await import('./privacidad');

beforeEach(() => { fila = null; });

describe('getDatosResponsable — sin razón social o domicilio, no hay responsable', () => {
  it('con razón social y domicilio, devuelve los datos', async () => {
    fila = { razon_social: 'FLOTA SA DE CV', domicilio_fiscal: 'Calle 1, Mérida', url_aviso_privacidad: '', contacto_privacidad: null };
    const r = await getDatosResponsable('t1');
    expect(r).not.toBeNull();
    expect(r?.razonSocial).toBe('FLOTA SA DE CV');
  });

  it('con domicilio vacío SÍ devuelve datos (la página los pinta con la fr. I pendiente), pero el aviso del canal se sigue negando', async () => {
    fila = { razon_social: 'FLOTA SA DE CV', domicilio_fiscal: '', url_aviso_privacidad: '', contacto_privacidad: null };
    const r = await getDatosResponsable('t1');
    expect(r).not.toBeNull();
    expect(r?.domicilio).toBe('');
    // La guarda que ANTES vivía aquí ahora vive donde le toca: sin domicilio
    // no sale el aviso simplificado (art. 15 fr. I) y el tratamiento por
    // WhatsApp se queda frenado — pero la página pública SÍ dice qué falta.
    expect(avisoSimplificado(r!)).toBeNull();
    const frI = avisoIntegral(r!).find((s) => s.fundamento.includes('15 fr. I'))!;
    expect(frI.pendiente).toBe(true);
    expect(frI.parrafos.join('\n')).toMatch(/aún no ha capturado su domicilio/i);
  });

  it('con razón social vacía, NO devuelve datos aunque haya domicilio', async () => {
    fila = { razon_social: '', domicilio_fiscal: 'Calle 1, Mérida', url_aviso_privacidad: '', contacto_privacidad: null };
    expect(await getDatosResponsable('t1')).toBeNull();
  });

  it('sin fila en la base, NO devuelve datos', async () => {
    fila = null;
    expect(await getDatosResponsable('t1')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, LEG-A2 [ALTO]: `url_aviso_privacidad` no tenía un solo
// escritor — ninguna pantalla de /admin ni /dashboard la captura — así que con
// la columna vacía el simplificado se degradaba y ARCO no tenía a dónde
// mandar, mientras `/aviso/<tenantId>` YA renderiza el integral para toda
// flota con razón social. `getDatosResponsable` ahora deriva la URL: gana la
// de la flota si pasa `revisarAvisoIntegral`; si no, cae a la página alojada.
// ═══════════════════════════════════════════════════════════════════════════
describe('getDatosResponsable — LEG-A2: la URL del integral se deriva, no se lee a secas', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';

  it('columna vacía → URL alojada (/aviso/<tenantId>)', async () => {
    fila = { razon_social: 'FLOTA SA DE CV', domicilio_fiscal: 'Calle 1, Mérida', url_aviso_privacidad: '', contacto_privacidad: null };
    const r = await getDatosResponsable(TENANT);
    expect(r?.urlAvisoIntegral).toBe(`https://app.likida.ai/aviso/${TENANT}`);
  });

  it('columna inservible de forma (localhost, sin TLD) → URL alojada', async () => {
    // `revisarAvisoIntegral` es una revisión de FORMA, no de existencia:
    // `flotademo.mx` (el NXDOMAIN real de producción) la pasa igual —
    // `aviso_integral.test.ts` ya lo deja escrito. Aquí se usa un caso que sí
    // falla la FORMA (sin dominio de primer nivel), que es lo único que esta
    // función puede detectar sin salir a la red.
    fila = { razon_social: 'FLOTA SA DE CV', domicilio_fiscal: 'Calle 1, Mérida', url_aviso_privacidad: 'https://intranet/aviso', contacto_privacidad: null };
    const r = await getDatosResponsable(TENANT);
    expect(r?.urlAvisoIntegral).toBe(`https://app.likida.ai/aviso/${TENANT}`);
  });

  it('columna con marcador de relleno (pendiente) → URL alojada', async () => {
    fila = { razon_social: 'FLOTA SA DE CV', domicilio_fiscal: 'Calle 1, Mérida', url_aviso_privacidad: 'https://flota.mx/aviso-pendiente', contacto_privacidad: null };
    const r = await getDatosResponsable(TENANT);
    expect(r?.urlAvisoIntegral).toBe(`https://app.likida.ai/aviso/${TENANT}`);
  });

  it('columna válida → gana la propia de la flota, no la alojada', async () => {
    fila = { razon_social: 'FLOTA SA DE CV', domicilio_fiscal: 'Calle 1, Mérida', url_aviso_privacidad: 'https://flotareal.mx/privacidad', contacto_privacidad: null };
    const r = await getDatosResponsable(TENANT);
    expect(r?.urlAvisoIntegral).toBe('https://flotareal.mx/privacidad');
  });
});
