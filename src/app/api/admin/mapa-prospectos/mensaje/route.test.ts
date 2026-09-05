import { peticionStream } from '@/lib/pruebas/peticion_stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 (C2): lo que sale hacia el modelo externo es la EMPRESA, no
// la persona. El nombre del decisor, su correo y su teléfono se quedan en
// Likida; el mensaje vuelve con el nombre de pila repuesto y con la liga del
// aviso de prospectos al pie (art. 16 fr. II).
// ═══════════════════════════════════════════════════════════════════════════

const llamadas: Array<{ system: string; messages: Array<{ content: string }> }> = [];
const escrituras: Array<Record<string, unknown>> = [];
const estadoSesion = vi.hoisted(() => ({ tenantId: '22222222-2222-2222-2222-222222222222' as string | null }));
const estadoCrm = vi.hoisted(() => ({ valor: 'nuevo' }));
const presupuestos = vi.hoisted(() => [] as unknown[][]);
/** BE-29: cuando está puesto, el `update` de la ficha falla. */
let errorAlGuardar: { message: string } | null = null;

const PROSPECTO = {
  id: '11111111-1111-1111-1111-111111111111',
  empresa: 'Fletes del Norte SA de CV',
  ciudad: 'Escobedo, Nuevo León',
  telefono: '8112345678',
  correo: 'contacto@fletesdelnorte.mx',
  contacto_nombre: 'Ing. Ramón Treviño',
  vacante: 'Auxiliar de liquidación de viajes',
  estado: 'nuevo',
  fuente: 'censo',
  notas: 'Hablé con Ramón Treviño (ramon.trevino@fletesdelnorte.mx, 81 1234 5678): liquidan a mano con Excel.',
};

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { ...PROSPECTO, estado: estadoCrm.valor }, error: null }) }) }),
      update: (v: Record<string, unknown>) => { escrituras.push(v); return { eq: () => Promise.resolve({ error: errorAlGuardar }) }; },
    }),
  }),
}));
vi.mock('@/lib/llm/budget', () => ({
  createLlmBudget: (...args: unknown[]) => { presupuestos.push(args); return { prueba: true }; },
}));
vi.mock('@/lib/llm/openrouter', () => ({
  generateStructured: (args: { system: string; messages: Array<{ content: string }> }) => {
    llamadas.push(args);
    return Promise.resolve({
      data: {
        mensaje_wa: 'Hola {{DECISOR}}, vi que buscan Auxiliar de liquidación de viajes — ese trabajo es el que automatizamos. ¿15 minutos esta semana?',
        correo_asunto: 'Su vacante de liquidación, {{DECISOR}}',
        correo_cuerpo: 'Estimado {{DECISOR}}: vi que Fletes del Norte busca Auxiliar de liquidación de viajes. Eso es lo que automatizamos: el operador manda sus comprobantes por WhatsApp y la liquidación sale cuadrada. ¿Tiene 15 minutos esta semana?\n\nJavier Cámara — Likida.ai',
      },
      model: 'prueba/modelo', tokensIn: 10, tokensOut: 20, cost: 0.0001,
    });
  },
}));
const cuotaMensaje = vi.fn(async () => true);
vi.mock('@/lib/ratelimit', () => ({ rateLimit: () => cuotaMensaje() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../puerta', () => ({
  sesionSuperadmin: () => Promise.resolve({
    error: null,
    sesion: { userId: 'u-1', tenantId: estadoSesion.tenantId },
  }),
}));

const { POST } = await import('./route');

function postear(cabeceras?: Record<string, string>) {
  return POST(new Request('https://app.likida.ai/api/admin/mapa-prospectos/mensaje', {
    method: 'POST', headers: cabeceras, body: JSON.stringify({ id: PROSPECTO.id }),
  }));
}

beforeEach(() => {
  cuotaMensaje.mockReset();cuotaMensaje.mockResolvedValue(true);
  llamadas.length = 0;
  escrituras.length = 0;
  errorAlGuardar = null;
  estadoCrm.valor = 'nuevo';
  presupuestos.length = 0;
  estadoSesion.tenantId = '22222222-2222-2222-2222-222222222222';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.likida.ai';
});

describe('la puerta de origen (auditoría 21, BAJO-MEDIO)', () => {
  it('desde otro sitio: 403 y el modelo ni se toca', async () => {
    const r = await postear({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(llamadas).toHaveLength(0);
    expect(escrituras).toHaveLength(0);
  });
});

describe('POST /api/admin/mapa-prospectos/mensaje — la persona no sale', () => {
  it.each(['won', 'cerrado', 'lost', 'perdido'])('%s se rechaza antes del presupuesto, modelo y escritura', async (estado) => {
    estadoCrm.valor = estado;

    const r = await postear();
    const j = await r.json() as { codigo?: string };

    expect(r.status).toBe(409);
    expect(j.codigo).toBe('prospecto_terminal');
    expect(presupuestos).toHaveLength(0);
    expect(llamadas).toHaveLength(0);
    expect(escrituras).toHaveLength(0);
  });

  it('un prospecto vivo sí crea un presupuesto, llama una vez al modelo y guarda una vez', async () => {
    estadoCrm.valor = 'proposal';
    expect((await postear()).status).toBe(200);
    expect(presupuestos).toHaveLength(1);
    expect(llamadas).toHaveLength(1);
    expect(escrituras).toHaveLength(1);
  });

  it('falla cerrado antes de llamar al modelo cuando la sesión no tiene tenant de presupuesto', async () => {
    estadoSesion.tenantId = null;

    const r = await postear();
    const j = await r.json() as { codigo: string };

    expect(r.status).toBe(503);
    expect(j.codigo).toBe('redactor_presupuesto_sin_tenant');
    expect(llamadas).toHaveLength(0);
    expect(escrituras).toHaveLength(0);
  });

  it('ni el nombre, ni el correo, ni el teléfono del decisor llegan al modelo', async () => {
    const r = await postear();
    expect(r.status).toBe(200);
    expect(llamadas).toHaveLength(1);
    const salio = llamadas[0].system + '\n' + llamadas[0].messages.map((m) => m.content).join('\n');
    for (const dato of ['Ramón', 'Treviño', 'ramon.trevino@', '1234 5678', '8112345678', 'contacto@fletesdelnorte']) {
      expect(salio, `salió "${dato}"`).not.toContain(dato);
    }
    // La empresa y la causa sí: es lo que el redactor necesita.
    expect(salio).toContain('Fletes del Norte');
    expect(salio).toContain('Auxiliar de liquidación');
    expect(salio).toContain('liquidan a mano');
    expect(salio).toContain('{{DECISOR}}');
  });

  it('el mensaje vuelve con el nombre de pila repuesto y la liga del aviso de prospectos', async () => {
    const r = await postear();
    const j = await r.json() as { mensajeWaIa: string; correoAsuntoIa: string; correoCuerpoIa: string };
    expect(j.mensajeWaIa).toMatch(/^Hola Ramón, vi que buscan/);
    expect(j.correoAsuntoIa).toBe('Su vacante de liquidación, Ramón');
    expect(j.correoCuerpoIa).toMatch(/^Estimado Ramón:/);
    expect(j.correoCuerpoIa).not.toContain('{{DECISOR}}');
    expect(j.mensajeWaIa).toContain('https://app.likida.ai/aviso/prospectos');
    expect(j.correoCuerpoIa).toContain('https://app.likida.ai/aviso/prospectos');
    // Y lo guardado es lo mismo que se devuelve.
    expect(escrituras[0].mensaje_wa).toBe(j.mensajeWaIa);
    expect(escrituras[0].mensaje_correo).toBe(j.correoCuerpoIa);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24, BE-29 — el modelo y el `update` vivían en el MISMO try: un
// bache al guardar contestaba 502 «El redactor no contestó». Dos mentiras: el
// redactor sí contestó (y ya se pagó), y los tres textos —que estaban en
// memoria— se tiraban. El vendedor apretaba otra vez y se pagaba de nuevo.
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-29 — lo que ya se pagó se entrega, aunque no se pueda guardar', () => {
  it('REPRO: el `update` falla y los textos VUELVEN igual, con el aviso de que no se guardaron', async () => {
    errorAlGuardar = { message: 'could not connect' };

    const r = await postear();
    const j = await r.json() as { mensajeWaIa?: string; correoCuerpoIa?: string; guardado?: boolean; aviso?: string; error?: string };

    expect(r.status).toBe(200);
    expect(j.error).toBeUndefined();
    expect(j.mensajeWaIa).toMatch(/^Hola Ramón, vi que buscan/);
    expect(j.correoCuerpoIa).toMatch(/^Estimado Ramón:/);
    // Y no se dice «guardado» cuando no se guardó.
    expect(j.guardado).toBe(false);
    expect(j.aviso).toContain('NO se pudieron guardar');
  });

  it('el camino bueno se rotula como guardado', async () => {
    const j = await (await postear()).json() as { guardado?: boolean; aviso?: string };
    expect(j.guardado).toBe(true);
    expect(j.aviso).toBeUndefined();
  });
});

describe('cuerpo acotado durante lectura', () => {
 it('cancela el exceso sin efectos', async()=>{
  const p=peticionStream('https://app.likida.ai/api/admin/mapa-prospectos/mensaje',JSON.stringify({...{id:PROSPECTO.id},ignorado:'x'.repeat(20000)}),8192);
  expect((await POST(p.req)).status).toBe(413);
  expect(p.estado().cancelado).toBe(true);expect(p.estado().leidos).toBeLessThan(p.estado().total);
  expect(llamadas).toHaveLength(0);expect(escrituras).toHaveLength(0);
 });
 it.each([null, [], 'texto', 42].map((valor) => [valor]))('rechaza cuerpo no objeto %j antes de efectos', async(cuerpo)=>{
  const p=peticionStream('https://app.likida.ai/api/admin/mapa-prospectos/mensaje',JSON.stringify(cuerpo));
  expect((await POST(p.req)).status).toBe(400);expect(llamadas).toHaveLength(0);expect(escrituras).toHaveLength(0);
 });
});

it('cuota agotada no lee ni genera',async()=>{
 cuotaMensaje.mockResolvedValue(false);const p=peticionStream('https://app.likida.ai/api/admin/mapa-prospectos/mensaje',JSON.stringify({id:PROSPECTO.id}));
 expect((await POST(p.req)).status).toBe(429);expect(p.estado().leidos).toBe(0);expect(llamadas).toHaveLength(0);expect(escrituras).toHaveLength(0);
});
it('id con tipo array no se convierte en UUID',async()=>{
 const p=peticionStream('https://app.likida.ai/api/admin/mapa-prospectos/mensaje',JSON.stringify({id:[PROSPECTO.id]}));
 expect((await POST(p.req)).status).toBe(400);expect(llamadas).toHaveLength(0);expect(escrituras).toHaveLength(0);
});
