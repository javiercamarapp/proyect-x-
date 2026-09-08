import { describe, it, expect } from 'vitest';
import { avisoSimplificado, avisoIntegral, versionAviso, type DatosResponsable, type SenalGps } from './privacidad';

// ═══════════════════════════════════════════════════════════════════════════
// EL AVISO DECLARA LA GEOLOCALIZACIÓN POR FLOTA — refinamiento del C.15,
// 28-ago-2026.
//
// El arreglo del 22-ago declaró el GPS del proveedor a TODA flota, siempre —
// y medido contra producción, `conector_credencial` estaba vacía: a ninguna
// flota le entraba una posición por proveedor y a todas se les declaraba. Un
// aviso que enumera tratamientos que no existen es tan inexacto como uno que
// los omite.
//
// Pero el proveedor NO es el único camino. Tres escritores reales de
// geolocalización, y solo el primero depende de un conector:
//
//   1. sincronizar_gps.ts + cron /api/cron/gps  → SOLO con credencial activa.
//   2. processor.ts → registrarUbicacionChofer  → el pin del chat, SIN conector.
//   3. asistencia_wa.ts → anclarUbicacionIncidencia → el pin de asistencia, SIN
//      conector.
//
// Por eso estas pruebas fijan DOS invariantes a la vez:
//
//   A. El renglón del PROVEEDOR varía según lo medido en `conector_credencial`.
//   B. El PIN DEL CHAT se declara SIEMPRE — en los tres estados — porque el
//      aviso viaja por el mismo canal desde el que cualquier chofer puede
//      mandarlo. Una flota CON tratamiento posible recibe un aviso que lo
//      declara, en todos los casos. Si alguien "afina" el aviso hasta callar
//      el pin, esto truena — y debe tronar: ese es el bug original C.15.
// ═══════════════════════════════════════════════════════════════════════════

const base: DatosResponsable = {
  razonSocial: 'TRANSPORTES DEL SURESTE SA DE CV',
  domicilio: 'Av. Itzáes 500, Mérida, Yucatán',
  urlAvisoIntegral: 'https://transportesdelsureste.mx/privacidad',
};

const conGps = (gps: SenalGps | undefined): DatosResponsable => ({ ...base, gps });
const integralTodo = (gps: SenalGps | undefined) =>
  avisoIntegral(conGps(gps)).flatMap((s) => [s.titulo, ...s.parrafos]).join('\n');

describe('avisoSimplificado — el renglón del proveedor, medido por flota', () => {
  it('con conector: afirma la posición de la unidad, sin condicional', () => {
    const a = avisoSimplificado(conGps('conectado'))!;
    expect(a).toMatch(/tu empresa tiene GPS en sus camiones/i);
    expect(a).toMatch(/posición\s+de\s+la\s+unidad/i);
  });

  it('sin conector: NO declara al proveedor como tratamiento que ocurre, y lo dice', () => {
    const a = avisoSimplificado(conGps('sin_conector'))!;
    expect(a).toMatch(/no tiene conectado un GPS/i);
    expect(a).not.toMatch(/posición\s+de\s+la\s+unidad/i);
    // Y anuncia el mecanismo del art. 15 fr. VI: si conecta uno, llega el nuevo.
    expect(a).toMatch(/este aviso cambia/i);
  });

  it('sin poder medir: falla CERRADO — el caso amplio, jamás el silencio', () => {
    // `no_medible` explícito y la ausencia total de la señal (un llamador que
    // no midió) tienen que dar lo MISMO: el condicional amplio de siempre.
    for (const gps of ['no_medible' as const, undefined]) {
      const a = avisoSimplificado(conGps(gps))!;
      expect(a).toMatch(/si tu empresa tiene GPS/i);
      expect(a).toMatch(/posición\s+de\s+la\s+unidad/i);
    }
    expect(avisoSimplificado(conGps('no_medible'))).toBe(avisoSimplificado(conGps(undefined)));
  });

  it('el PIN DEL CHAT se declara en los TRES estados — es el invariante que no se negocia', () => {
    // El pin no depende de conector alguno: funciona hoy, en cualquier flota,
    // por el mismo chat por el que llega este aviso. Callarlo en cualquiera de
    // los estados sería volver al bug original (C.15).
    for (const gps of ['conectado', 'sin_conector', 'no_medible'] as const) {
      const a = avisoSimplificado(conGps(gps))!;
      expect(a).toMatch(/compartes tu ubicación por el chat/i);
      expect(a).toMatch(/se guarda y la ve tu jefe/i);
      // Con sus límites verdaderos en los tres: retención y teléfono.
      expect(a).toMatch(/90 días/i);
      expect(a).toMatch(/tu teléfono no se rastrea/i);
      // Y jamás la frase falsa que originó todo.
      expect(a).not.toMatch(/no hay gps/i);
    }
  });

  it('cada estado cabe en un mensaje de WhatsApp', () => {
    for (const gps of ['conectado', 'sin_conector', 'no_medible'] as const) {
      expect(avisoSimplificado(conGps(gps))!.length).toBeLessThan(1900);
    }
  });

  it('cambiar de estado cambia la versión: conectar un GPS reenvía el aviso solo (art. 15 fr. VI)', () => {
    const v = (gps: SenalGps) => versionAviso(avisoSimplificado(conGps(gps))!);
    expect(v('sin_conector')).not.toBe(v('conectado'));
    expect(v('sin_conector')).not.toBe(v('no_medible'));
    expect(v('conectado')).not.toBe(v('no_medible'));
  });

  it('el texto de no_medible es EL MISMO que salió a producción el 22-ago', () => {
    // Byte-idéntico a propósito: una falla transitoria de la medición no debe
    // cambiar `versionAviso` respecto de lo ya entregado, o un blip de base
    // dispara un reenvío a media flota. Si este renglón se reescribe, hay que
    // saber que el reenvío masivo es intencional.
    expect(avisoSimplificado(conGps('no_medible'))).toContain(
      'Sobre tu ubicación: si tu empresa tiene GPS en sus camiones, se recibe la *posición de la unidad* que manejas para medir los tiempos del viaje y enseñárselos a la empresa; si compartes tu ubicación por el chat, también se guarda y la ve tu jefe. Se borra a los 90 días. Tu teléfono no se rastrea.',
    );
  });
});

describe('avisoIntegral — fr. II y fr. III, medidas por flota', () => {
  it('con conector: enumera la posición GPS de la unidad como dato y su uso como finalidad', () => {
    const t = integralTodo('conectado');
    expect(t).toMatch(/posición GPS de la unidad/i);
    expect(t).toMatch(/tiene contratado un rastreo satelital/i);
    expect(t).toMatch(/posiciones GPS de la unidad para el seguimiento/i);
  });

  it('sin conector: el proveedor no se enumera como dato, pero el pin del chat SÍ — con finalidad y oposición', () => {
    const t = integralTodo('sin_conector');
    expect(t).toMatch(/no tiene conectado un rastreo satelital/i);
    expect(t).not.toMatch(/posición GPS de la unidad que traes asignada/i);
    // El pin sigue enumerado (fr. II), con retención y límite del teléfono.
    expect(t).toMatch(/ubicación que tú decidas compartir/i);
    expect(t).toMatch(/90 días/i);
    expect(t).toMatch(/tu teléfono no se rastrea/i);
    // Y su finalidad sigue entre las NO necesarias, con oposición (fr. III).
    const frIII = avisoIntegral(conGps('sin_conector')).find((s) => s.fundamento.includes('15 fr. III'))!;
    const f = frIII.parrafos.join('\n');
    const rotulo = f.indexOf('NO son necesarias');
    const pin = f.indexOf('ubicación que tú compartas por el chat');
    expect(rotulo).toBeGreaterThan(-1);
    expect(pin).toBeGreaterThan(rotulo);
    expect(f).toMatch(/oponerte/i);
    // Sin proveedor no se promete un contrato con proveedor que no existe.
    expect(f).not.toMatch(/contrato de tu empresa con su proveedor/i);
  });

  it('sin poder medir: el caso amplio, igual que la ausencia de señal', () => {
    for (const gps of ['no_medible' as const, undefined]) {
      const t = integralTodo(gps);
      expect(t).toMatch(/posición GPS de la unidad/i);
      expect(t).toMatch(/cuando tu empresa tiene contratado un rastreo satelital/i);
    }
    expect(integralTodo('no_medible')).toBe(integralTodo(undefined));
  });

  it('la frase falsa no vuelve en ningún estado', () => {
    for (const gps of ['conectado', 'sin_conector', 'no_medible'] as const) {
      expect(integralTodo(gps)).not.toMatch(/No hay GPS/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, LEG-A3 [ALTO]: el simplificado (fr. II) omitía seis categorías
// que el integral SÍ declara — voz, mensajes, salud (SENSIBLE), RFC/licencia,
// contacto de emergencia y cámara/telemetría. El simplificado y el integral de
// una misma flota no pueden declarar cosas distintas.
// ═══════════════════════════════════════════════════════════════════════════
describe('avisoSimplificado — LEG-A3: ya enumera lo que el integral declara', () => {
  it('menciona voz, contenido de mensajes, RFC y licencia, en cualquier estado', () => {
    for (const gps of ['conectado', 'sin_conector', 'no_medible'] as const) {
      const a = avisoSimplificado(conGps(gps))!;
      expect(a).toMatch(/notas? de voz/i);
      expect(a).toMatch(/mensajes/i);
      expect(a).toMatch(/RFC/);
      expect(a).toMatch(/licencia/i);
    }
  });

  it('declara el dato de salud "si hay lesionados" marcado como sensible, sin condicionarlo al GPS', () => {
    for (const gps of ['conectado', 'sin_conector', 'no_medible'] as const) {
      const a = avisoSimplificado(conGps(gps))!;
      expect(a).toMatch(/sensible/i);
      expect(a).toMatch(/lesionados/i);
      expect(a).toMatch(/accidente/i);
    }
  });

  it('declara el contacto de emergencia, en cualquier estado', () => {
    for (const gps of ['conectado', 'sin_conector', 'no_medible'] as const) {
      expect(avisoSimplificado(conGps(gps))!).toMatch(/contacto de emergencia/i);
    }
  });

  it('la cámara/telemetría reutiliza la MISMA señal que el integral: se calla sin conector', () => {
    const conConector = avisoSimplificado(conGps('conectado'))!;
    const sinConector = avisoSimplificado(conGps('sin_conector'))!;
    const noMedible = avisoSimplificado(conGps('no_medible'))!;
    expect(conConector).toMatch(/cámara|telemetría/i);
    expect(noMedible).toMatch(/cámara|telemetría/i);
    // Sin conector NO hay tratamiento de cámara: declararlo sería tan
    // inexacto como omitirlo cuando sí ocurre.
    expect(sinConector).not.toMatch(/cámara|telemetría/i);
  });

  it('el párrafo de ubicación no_medible sigue byte-idéntico pese a los añadidos', () => {
    // El invariante que `aviso_gps_por_flota.test.ts` ya fijaba arriba: el
    // renglón de `sobreUbicacion` no se toca al enumerar las categorías nuevas.
    expect(avisoSimplificado(conGps('no_medible'))).toContain(
      'Sobre tu ubicación: si tu empresa tiene GPS en sus camiones, se recibe la *posición de la unidad* que manejas para medir los tiempos del viaje y enseñárselos a la empresa; si compartes tu ubicación por el chat, también se guarda y la ve tu jefe. Se borra a los 90 días. Tu teléfono no se rastrea.',
    );
  });
});
