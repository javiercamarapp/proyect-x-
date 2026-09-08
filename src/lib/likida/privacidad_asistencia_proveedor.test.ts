import { describe, it, expect } from 'vitest';
import { avisoIntegral, type DatosIntegral } from './privacidad';
import { armarMensajeProveedor } from './asistencia_coordinacion';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 29, LEG-C1 [CRÍTICO] — la ubicación que el chofer comparte por el
// chat se transfiere a un proveedor comercial externo (grúa, llantera, auxilio
// mecánico, apoyo médico) y el aviso enumeraba una lista CERRADA de
// transferencias que no lo incluía.
//
// El circuito real: el chofer se queda varado y manda su pin;
// `anclarUbicacionIncidencia` lo guarda ligado a `operador_id`; la contralora
// aprieta el botón; `armarMensajeProveedor` arma un mensaje con
// `https://maps.google.com/?q=<lat>,<lng>` y `sendText` lo entrega al WhatsApp
// de un tercero que no firmó nada con la flota.
//
// Una grúa contratada por evento NO es persona encargada: no trata los datos
// por cuenta del responsable, presta su propio servicio. Es una TRANSFERENCIA.
// `normas/lfpdppp-2-XII-XX.yaml` (`verificado_fuente_primaria`), art. 35
// literal: «Cuando el responsable pretenda transferir los datos personales a
// terceros nacionales o extranjeros, DISTINTOS DE LA PERSONA ENCARGADA, deberá
// comunicar a éstos el aviso de privacidad y las finalidades a las que la
// persona titular sujetó su tratamiento». Y el art. 15 fr. II/III exige
// declarar los datos tratados y sus finalidades.
//
// Antes de este arreglo, `grep -n "grúa|llantera|auxilio|taller"
// src/lib/likida/privacidad.ts` daba CERO, mientras el aviso cerraba su lista
// con: «Transferencias que sí lo son y no necesitan tu consentimiento: a la
// autoridad fiscal cuando la ley lo exige, y al contador de la empresa» y
// remataba «Si algún día se quisiera transferir tus datos para algo distinto,
// se te pedirá permiso antes».
//
// Lo que se fija aquí no es una redacción: es que el aviso NOMBRE el flujo que
// el código ejecuta, con el dato que de verdad sale (la ubicación) y hacia
// quién sale (un tercero que no es encargado).
// ═══════════════════════════════════════════════════════════════════════════

const BASE: Omit<DatosIntegral, 'gps'> = {
  razonSocial: 'TRANSPORTES DEL BAJÍO SA DE CV',
  domicilio: 'Carr. 57D km 12, Querétaro, Qro.',
  urlAvisoIntegral: 'https://transportesdelbajio.mx/privacidad',
  contactoPrivacidad: null,
};

/** La sección de transferencias, que es donde la omisión importaba: es la que
 *  el titular lee para saber quién más va a tener sus datos. */
function seccionTransferencias(gps: DatosIntegral['gps']): string {
  const s = avisoIntegral({ ...BASE, gps }).find((x) => /art\. 3[56]|transferen/i.test(`${x.fundamento} ${x.titulo}`));
  if (!s) throw new Error('no se encontró la sección de transferencias del aviso integral');
  return s.parrafos.join(' ');
}

describe('LEG-C1 · el aviso declara la transferencia al proveedor de auxilio en carretera', () => {
  // El circuito de asistencia no depende del conector de GPS: nace del pin que
  // el chofer manda por el chat. Se declara en los tres casos de la señal.
  for (const gps of ['conectado', 'sin_conector', 'no_medible'] as const) {
    it(`con gps='${gps}': la sección de transferencias nombra al proveedor de auxilio`, () => {
      const t = seccionTransferencias(gps);
      expect(t, 'el aviso tiene que nombrar a quién sale el dato').toMatch(/grúa|grua|llantera|auxilio en carretera/i);
    });

    it(`con gps='${gps}': dice que lo que sale es la UBICACIÓN, no un genérico`, () => {
      const t = seccionTransferencias(gps);
      const parrafo = t.split('. ').find((p) => /grúa|grua|llantera|auxilio/i.test(p)) ?? t;
      expect(parrafo).toMatch(/ubicaci[óo]n/i);
    });
  }

  it('lo declara como TRANSFERENCIA, no lo esconde entre las personas encargadas', () => {
    // La distinción es la del art. 2 fr. XX contra el art. 35, y el propio
    // aviso ya la explica: meter aquí a la grúa como "encargado" sería repetir
    // el error con otra cara.
    const secciones = avisoIntegral({ ...BASE, gps: 'conectado' });
    const transf = secciones.find((x) => /art\. 3[56]|transferen/i.test(`${x.fundamento} ${x.titulo}`))!;
    const parrafoProveedor = transf.parrafos.find((p) => /grúa|grua|llantera|auxilio en carretera/i.test(p))!;
    expect(parrafoProveedor, 'el párrafo del auxilio existe').toBeTruthy();
    expect(
      parrafoProveedor,
      'no puede presentarse como "no es una transferencia": la grúa presta su propio servicio',
    ).not.toMatch(/no es una transferencia/i);
  });

  it('la lista de transferencias deja de presentarse como cerrada de dos', () => {
    // El texto viejo enumeraba exactamente dos destinos y remataba con «si
    // algún día se quisiera transferir tus datos para algo distinto, se te
    // pedirá permiso antes» — una promesa que el circuito de asistencia ya
    // estaba rompiendo el día que se escribió.
    const transf = avisoIntegral({ ...BASE, gps: 'conectado' })
      .find((x) => /art\. 3[56]|transferen/i.test(`${x.fundamento} ${x.titulo}`))!;
    const enumeracion = transf.parrafos.find((p) => /no necesitan tu consentimiento/i.test(p))!;
    expect(enumeracion, 'la enumeración de transferencias existe').toBeTruthy();
    // El párrafo que enumera ya no puede terminar en los dos destinos de
    // siempre: el tercero —el proveedor de auxilio— tiene que estar ahí mismo,
    // o el titular lee una lista que su propio caso contradice.
    expect(
      enumeracion,
      'la enumeración tiene que cubrir también al proveedor de auxilio, no quedarse en dos',
    ).toMatch(/auxilio/i);
  });

  it('el mensaje que de verdad sale lleva la coordenada: el aviso no exagera ni se queda corto', () => {
    // Ancla el aviso al código: si alguien deja de mandar la coordenada, esta
    // prueba avisa de que el aviso pasó a declarar de más.
    const mensaje = armarMensajeProveedor({
      flota: 'TRANSPORTES DEL BAJÍO SA DE CV',
      tipoProveedor: 'llantera',
      unidad: 'T-402',
      lat: 20.9123,
      lng: -100.744,
      telefonoJefe: '5214771234567',
    });
    expect(mensaje).toContain('https://maps.google.com/?q=20.9123,-100.744');
  });
});
