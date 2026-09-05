import { describe, it, expect, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL INVESTIGADOR (0217) — el contrato que lo define es la COMPUERTA LITERAL:
// un correo que el modelo devuelva y que no aparezca textualmente en las
// páginas descargadas (o en las notas) NO existe. Es la defensa de código
// contra el contacto inventado — el fallo que ya quemó un lead real (un
// correo de OTRA empresa pegado por error de scraping).
// ═══════════════════════════════════════════════════════════════════════════

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// AGB-3: builder real por tabla, con una cola de respuestas por tabla — el
// mismo patrón que enviador.test.ts — para poder ejercer `candidatosSinDossier`
// (antes el mock trivial `from: () => ({})` bastaba porque nada la probaba).
const respuestas = new Map<string, Array<{ data: unknown; error: { message: string } | null }>>();
function builder(tabla: string) {
  const responder = () => {
    const cola = respuestas.get(tabla);
    return cola && cola.length > 0 ? cola.shift()! : { data: [], error: null };
  };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, is: () => b, in: () => b, or: () => b,
    order: () => b, limit: () => b, insert: () => b, upsert: () => b,
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(responder).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));
vi.mock('../interruptores', () => ({ estaApagado: async () => false }));
vi.mock('@/lib/llm/openrouter', () => ({ generateStructured: vi.fn() }));
vi.mock('./corridas', () => ({ registrarCorrida: vi.fn() }));

const { textoVisible, enlacesInstitucionales, correosVerificados, cosecharCorreosDeNotas, candidatosSinDossier } = await import('./investigador');

describe('correosVerificados — la compuerta literal contra el contacto inventado', () => {
  const paginas = [{ url: 'https://x.mx/contacto', texto: 'Escríbenos a VENTAS@x.mx o llama al 8112345678' }];

  it('deja pasar el correo que SÍ está en la página (sin importar mayúsculas) y anota la URL como fuente', () => {
    const r = correosVerificados(
      [{ correo: 'ventas@x.mx', contacto_nombre: null, puesto: null, fuente: 'https://x.mx/contacto' }],
      paginas, null,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ correo: 'ventas@x.mx', fuente: 'https://x.mx/contacto' });
  });

  it('DESCARTA el correo que el modelo "recuerde" y no esté en ninguna página ni en las notas', () => {
    const r = correosVerificados(
      [{ correo: 'director@x.mx', contacto_nombre: 'Juan', puesto: 'Director', fuente: 'https://x.mx' }],
      paginas, null,
    );
    expect(r).toHaveLength(0);
  });

  it('las notas del prospecto también son fuente literal válida', () => {
    const r = correosVerificados(
      [{ correo: 'gerencia@x.mx', contacto_nombre: null, puesto: null, fuente: 'lo que sea' }],
      paginas, 'Contacto de ANIQ: gerencia@x.mx (gerente)',
    );
    expect(r).toHaveLength(1);
    expect(r[0].fuente).toBe('notas del prospecto');
  });

  it('descarta formatos rotos y deduplica', () => {
    const r = correosVerificados(
      [
        { correo: 'no-es-correo', contacto_nombre: null, puesto: null, fuente: 'x' },
        { correo: 'ventas@x.mx', contacto_nombre: null, puesto: null, fuente: 'x' },
        { correo: 'VENTAS@X.MX', contacto_nombre: null, puesto: null, fuente: 'x' },
      ],
      paginas, null,
    );
    expect(r).toHaveLength(1);
  });
});

describe('cosecharCorreosDeNotas — la cosecha gratis que ya está pagada', () => {
  it('extrae y deduplica los correos del texto de las notas', () => {
    expect(cosecharCorreosDeNotas('Correo: a@b.mx; también A@B.MX y ventas@c.com.mx')).toEqual(['a@b.mx', 'ventas@c.com.mx']);
  });
  it('sin notas, lista vacía — no un invento', () => {
    expect(cosecharCorreosDeNotas(null)).toEqual([]);
  });
});

describe('textoVisible y enlacesInstitucionales — el rastreo mínimo', () => {
  it('quita scripts/estilos/etiquetas y colapsa espacios', () => {
    expect(textoVisible('<script>var x=1</script><p>Hola  <b>mundo</b></p><style>.a{}</style>'))
      .toBe('Hola mundo');
  });

  it.each(['</script >', '</ScRiPt\t>', '</script\r\n>', '</script\f>'])('omite contenido de script con cierre HTML %s antes de verificar correos', (cierre) => {
    const texto = textoVisible(`<p>ventas@empresa.example</p><script>const x="interno@empresa.example";${cierre}<p>Fin</p>`);
    expect(texto).toBe('ventas@empresa.example Fin');
    const correos = ['ventas@empresa.example', 'interno@empresa.example'].map(correo => ({ correo, contacto_nombre: null, puesto: null, fuente: 'https://empresa.example' }));
    expect(correosVerificados(correos, [{ url: 'https://empresa.example', texto }], null).map(c => c.correo)).toEqual(['ventas@empresa.example']);
  });

  it.each(['</style >', '</STYLE\n>'])('omite estilos con cierre HTML %s', (cierre) => {
    expect(textoVisible(`<p>Contacto</p><style>.x{content:"oculto"}${cierre}<p>Fin</p>`)).toBe('Contacto Fin');
  });

  it.each(['script', 'style'])('respeta comillas en la apertura de %s antes de buscar el cierre', tag => {
    const html = `<p>visible</p><${tag} data-x="> </${tag} >">interno@empresa.example</${tag}><p>Fin</p>`;
    expect(textoVisible(html)).toBe('visible Fin');
  });

  it('las etiquetas dentro de un comentario no se comen el contenido visible posterior', () => {
    const html = '<p>Uno</p><!-- <script>no es una apertura real --><p>Dos</p><script>oculto</script><p>Tres</p>';
    expect(textoVisible(html)).toBe('Uno Dos Tres');
  });

  it('un bloque sin cierre sigue siendo contenido no visible hasta EOF', () => {
    expect(textoVisible('<p>Contacto</p><script>oculto')).toBe('Contacto');
    expect(textoVisible('<p>Contacto</p><style>oculto')).toBe('Contacto');
  });

  it('no confunde nombres de otras etiquetas con script o style', () => {
    expect(textoVisible('<scripture>visible</scripture><script>oculto</script><stylesheet>también</stylesheet><style>oculto</style>')).toBe('visible también');
  });

  it('solo sigue enlaces del MISMO dominio que huelen a contacto/nosotros', () => {
    const html = `
      <a href="/contacto">Contacto</a>
      <a href="https://x.mx/nosotros">Nosotros</a>
      <a href="https://otro.com/contacto">Ajeno</a>
      <a href="/blog/post-1">Blog</a>`;
    const r = enlacesInstitucionales(html, new URL('https://x.mx'));
    expect(r).toEqual(['https://x.mx/contacto', 'https://x.mx/nosotros']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA FABLE CICLO 5 — c5-4 (compuerta de dominio) y c5-11 (SSRF).
// ═══════════════════════════════════════════════════════════════════════════
const { separarPorDominio, esIpPrivada, MAX_CORREOS_EMPRESA } = await import('./investigador');

describe('c5-4 — la compuerta de dominio: correos de terceros JAMÁS entran a la lista de envío', () => {
  const correo = (c: string) => ({ correo: c, contacto_nombre: null, puesto: null, fuente: 'https://www.empresa.mx/contacto' });

  it('el webmaster de la agencia del pie NO es de la empresa — va a ajenos', () => {
    const { propios, ajenos } = separarPorDominio(
      [correo('ventas@empresa.mx'), correo('webmaster@agenciadigital.com')],
      'https://www.empresa.mx', 'contacto@empresa.mx',
    );
    expect(propios.map((c) => c.correo)).toEqual(['ventas@empresa.mx']);
    expect(ajenos.map((c) => c.correo)).toEqual(['webmaster@agenciadigital.com']);
  });

  it('el dominio del correo PRINCIPAL también permite (pymes con gmail)', () => {
    const { propios } = separarPorDominio(
      [correo('otro@gmail.com')],
      'https://www.empresa.mx', 'dueno@gmail.com',
    );
    expect(propios.map((c) => c.correo)).toEqual(['otro@gmail.com']);
  });

  it('sin sitio ni principal, TODO es ajeno — nada entra a ciegas', () => {
    const { propios, ajenos } = separarPorDominio([correo('x@y.mx')], null, null);
    expect(propios).toHaveLength(0);
    expect(ajenos).toHaveLength(1);
  });

  it('www. no estorba la coincidencia', () => {
    const { propios } = separarPorDominio([correo('a@empresa.com.mx')], 'https://www.empresa.com.mx/inicio', null);
    expect(propios).toHaveLength(1);
  });

  it('el tope por empresa existe y es finito (sitio hostil con cientos de correos)', () => {
    expect(MAX_CORREOS_EMPRESA).toBeGreaterThan(0);
    expect(MAX_CORREOS_EMPRESA).toBeLessThanOrEqual(30);
  });
});

describe('c5-11 — la frontera SSRF: IPs privadas jamás se visitan', () => {
  it('clasifica las privadas/loopback/link-local como privadas', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1']) {
      expect(esIpPrivada(ip), ip).toBe(true);
    }
  });
  it('las públicas pasan', () => {
    for (const ip of ['8.8.8.8', '104.18.32.7', '201.150.36.1', '2607:f8b0::1']) {
      expect(esIpPrivada(ip), ip).toBe(false);
    }
  });
  it('172.15 y 172.32 NO son privadas (el /12 es exacto)', () => {
    expect(esIpPrivada('172.15.0.1')).toBe(false);
    expect(esIpPrivada('172.32.0.1')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AGB-3 (auditoría 24, 1-sep-2026) — `candidatosSinDossier` con una ventana
// FIJA devolvía `[]` para siempre en cuanto los N más viejos ya tenían
// dossier (medido en producción: 25/25). El cursor tiene que AVANZAR a la
// siguiente página dentro de la misma llamada, no repetir la misma ventana.
// ═══════════════════════════════════════════════════════════════════════════
function filaProspecto(n: number) {
  // created_at estrictamente creciente — el orden que el cursor recorre.
  return { id: `pr-${String(n).padStart(4, '0')}`, created_at: `2026-08-${String(1 + Math.floor(n / 1000)).padStart(2, '0')}T00:${String(n % 60).padStart(2, '0')}:00.000Z` };
}

describe('candidatosSinDossier — el cursor avanza más allá de una página agotada', () => {
  it('con la primera página de 100 TODA con dossier, sigue a la segunda página y encuentra ahí a los candidatos', async () => {
    const pagina1 = Array.from({ length: 100 }, (_, i) => filaProspecto(i));
    const pagina2 = [filaProspecto(100), filaProspecto(101), filaProspecto(102)]; // página parcial: fin de la tabla
    respuestas.set('prospecto', [
      { data: pagina1, error: null },
      { data: pagina2, error: null },
    ]);
    respuestas.set('prospecto_dossier', [
      { data: pagina1.map((f) => ({ prospecto_id: f.id })), error: null }, // los 100 de la página 1: TODOS con dossier
      { data: [{ prospecto_id: pagina2[0].id }], error: null },            // de la página 2, solo el primero tiene dossier
    ]);
    const r = await candidatosSinDossier(5);
    expect(r).toEqual([pagina2[1].id, pagina2[2].id]);
  });

  it('sin más filas (página vacía), el cursor se detiene y devuelve lo que ya juntó — sin colgarse', async () => {
    respuestas.set('prospecto', [{ data: [], error: null }]);
    respuestas.set('prospecto_dossier', []);
    const r = await candidatosSinDossier(5);
    expect(r).toEqual([]);
  });

  it('una página parcial (menor al tamaño de página) para el cursor sin pedir una vuelta de más', async () => {
    const pagina = [filaProspecto(0), filaProspecto(1)];
    respuestas.set('prospecto', [{ data: pagina, error: null }]);
    respuestas.set('prospecto_dossier', [{ data: [], error: null }]);
    const r = await candidatosSinDossier(5);
    expect(r).toEqual([pagina[0].id, pagina[1].id]);
    // Solo UNA respuesta de 'prospecto' quedaba en cola — si el cursor hubiera
    // pedido otra vuelta habría consumido el `{data: [], error: null}` default
    // del builder, indistinguible aquí; lo que sí es observable es que el
    // resultado no incluye nada de una vuelta fantasma.
    expect(respuestas.get('prospecto')).toHaveLength(0);
  });
});
