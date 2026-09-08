// ═══════════════════════════════════════════════════════════════════════════
// LA ENTREVISTA DEL DUEÑO — primera apertura.
//
// PERFIL-OPERATIVO.md: un cuestionario de 40 preguntas nadie lo llena, y el
// que lo llena miente. Esto es un chat: una pregunta a la vez, cada una con
// su sustento, y "no sé" deja el campo ausente — nunca un default fiscal.
//
// El modelo (si se usa) SOLO habla. Las declaraciones pasan por estos
// parsers. Un sí genérico solo responde la pregunta de turno, no rellena
// las demás.
// ═══════════════════════════════════════════════════════════════════════════

import { CONECTORES } from '@/lib/likida/conectores/registro';
import {
  calificaEstimuloPeaje, onboardingFiscalListo, umbralPeajeDeclarado,
  type DatosOnboarding, type RolAviso,
} from './preguntas';

export type CampoEntrevista =
  | 'ingresosMenoresA300M'
  | 'parteRelacionada'
  | 'rfcEmpresa'
  | 'razonSocial'
  | 'regimenSat'
  | 'codigoPostalFiscal'
  | 'dedicacionExclusivaCarga'
  | 'transporteDedicado'
  | 'hombreCamion'
  | 'tarjetasANombreEmpresa'
  | 'pagoEnBomba'
  | 'creditoEstacion'
  | 'casetasRedNacional'
  | 'gps'
  | 'erp'
  | 'tms'
  | 'tag'
  | 'monedero'
  | 'portalFacturacion'
  | 'pagoOperador'
  | 'tanquePropio'
  | 'topesPolitica'
  | 'operadoresAlta'
  | 'unidadesAlta'
  | 'telefonoJefe'
  | 'cobranzaVentana'
  | 'ordenAviso'
  | 'hazmat'
  | 'poliza'
  | 'emailFacturacion';

export interface OpcionChip { valor: string; etiqueta: string }

export interface PreguntaEntrevista {
  id: CampoEntrevista;
  titulo: string;
  pregunta: string;
  porQue: string;
  sustento: { cita: string; normaId: string | null; texto: string };
  chips: OpcionChip[];
  requeridaParaPanel: boolean;
}

export type Parseo =
  | { ok: true; hechos: Partial<DatosOnboarding> }
  | { ok: false; motivo: 'no_se' | 'ambiguo'; detalle: string };

const SI_NO: OpcionChip[] = [
  { valor: 'si', etiqueta: 'Sí' },
  { valor: 'no', etiqueta: 'No' },
  { valor: 'no_se', etiqueta: 'No lo sé todavía' },
];

function strip(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

export const CATALOGO: PreguntaEntrevista[] = [
  {
    id: 'ingresosMenoresA300M',
    titulo: 'Ingresos del ejercicio',
    pregunta: '¿Los ingresos totales anuales de la flota en el último ejercicio fueron menores a $300 millones de pesos?',
    porQue: 'Sin esto el motor aplica el 50% de peaje a cualquier flota, también a una que no califica.',
    sustento: {
      cita: 'LIF 2026 art. 20-A',
      normaId: 'lif-2026-art-20-A',
      texto: 'El estímulo de peaje del 50% exige ingresos menores a $300 millones. $300 millones exactos ya no califican. Likida no verifica la dedicación exclusiva ni que las casetas sean de la Red Nacional: eso lo declara la flota.',
    },
    chips: [
      { valor: 'menor', etiqueta: 'Menores a $300 millones' },
      { valor: 'mayor', etiqueta: '$300 millones o más' },
      { valor: 'no_se', etiqueta: 'No lo sé todavía' },
    ],
    requeridaParaPanel: true,
  },
  {
    id: 'parteRelacionada',
    titulo: 'Parte relacionada',
    pregunta: '¿Esta flota es parte relacionada de otra empresa, en los términos del artículo 179 de la LISR?',
    porQue: 'Aunque los ingresos estén bajo el umbral, ser parte relacionada apaga el estímulo de peaje.',
    sustento: {
      cita: 'LISR art. 179',
      normaId: null,
      texto: 'El art. 179 de la LISR define partes relacionadas (control, administración o parentesco). No hay ficha transcrita de ese artículo en normas/: si no estás seguro, déjalo pendiente — no se afirma un "no".',
    },
    chips: SI_NO,
    requeridaParaPanel: true,
  },
  {
    id: 'rfcEmpresa',
    titulo: 'RFC de la flota',
    pregunta: '¿Cuál es el RFC de la empresa, tal cual la Constancia de Situación Fiscal? Lo necesito para comprobar que las facturas vengan a su nombre. Sin un RFC válido, esa comprobación se apaga y no rechazamos un CFDI a nombre de otro.',
    porQue: 'LISR 27-III / CFF 29-A: la deducción se ampara con un CFDI a nombre del contribuyente. Un dígito mal tecleado deja la validación de receptor apagada.',
    sustento: {
      cita: 'CFF 29-A',
      normaId: 'cff-29-A',
      texto: 'El RFC se valida con dígito verificador. No se “arregla”. Si no lo tienes a la mano, consúltalo en la constancia — no voy a inventar uno.',
    },
    chips: [{ valor: 'no_se', etiqueta: 'Lo busco y te lo digo después' }],
    requeridaParaPanel: false,
  },
  {
    id: 'razonSocial',
    titulo: 'Razón social',
    pregunta: '¿Razón social TAL CUAL está en la Constancia? El SAT la compara letra por letra; no la “limpio”.',
    porQue: 'Los cinco datos del receptor CFDI 4.0: RFC, razón social, régimen, CP fiscal y uso. Sin los cinco, Likida no puede facturarte a ti ni comprobar bien a nombre de quién vienen las de tus proveedores.',
    sustento: { cita: 'CFDI 4.0 — datos del receptor', normaId: 'cff-29-A', texto: 'Se guarda tal cual la escribiste. Un “S.A de C.V.” vs “S.A. DE C.V.” lo rechaza el PAC.' },
    chips: [{ valor: 'no_se', etiqueta: 'La busco en la constancia' }],
    requeridaParaPanel: false,
  },
  {
    id: 'regimenSat',
    titulo: 'Régimen fiscal (clave SAT)',
    pregunta: '¿En qué régimen tributan? La clave SAT, no un “sí califico”. RESICO (626) y el régimen general de persona moral (601) NO abren la facilidad del 15%. Coordinados es 624 (Título II Cap. VII); persona física act. empresarial es 612.',
    porQue: 'De la clave se DERIVA si aplica RFA 2.9. Un “sí” cómodo acreditaría una facilidad que el SAT puede negar. 624 es el régimen del receptor al timbrar la mensualidad; Likida no emite los CFDIs de los viajes del coordinado.',
    sustento: {
      cita: 'RFA 2026 regla 2.9 · catálogo c_RegimenFiscal',
      normaId: 'rfa-2026-2.9',
      texto: 'Elegibles a la facilidad: 612 (PF act. empresarial) y 624 (coordinados). 601, 626 y el resto quedan en LISR 27-III sin excepción para el efectivo de combustible.',
    },
    chips: [
      { valor: '612', etiqueta: '612 · PF con actividad empresarial (sí 15%)' },
      { valor: '601', etiqueta: '601 · Persona moral general (no 15%)' },
      { valor: '626', etiqueta: '626 · RESICO (no 15%)' },
      { valor: '624', etiqueta: '624 · Coordinados (sí 15%)' },
      { valor: '621', etiqueta: '621 · Incorporación fiscal' },
      { valor: 'no_se', etiqueta: 'No lo sé todavía' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'codigoPostalFiscal',
    titulo: 'Código postal fiscal',
    pregunta: '¿CP del domicilio fiscal registrado ante el SAT? Cinco dígitos. No es el del patio: el PAC lo compara contra el que el SAT tiene para ese RFC.',
    porQue: 'Quinto dato del receptor. Sin él no se timbra ni se cierra el paquete fiscal.',
    sustento: { cita: 'CFDI 4.0 — código postal del receptor', normaId: 'cff-29-A', texto: 'Cinco dígitos. No invento un CP de la ciudad que me dijiste.' },
    chips: [{ valor: 'no_se', etiqueta: 'Lo busco en la constancia' }],
    requeridaParaPanel: false,
  },
  // AUDITORÍA 28 (FIS-M1, MEDIO): esta pregunta incluía «pasaje o turismo».
  // El texto VERIFICADO de la RFA 2026 regla 2.9 (normas/rfa-2026-2.9.yaml,
  // verificado_fuente_primaria) dice SOLO «carga federal» — igual que 2.1 y
  // 2.2, las otras dos reglas del mismo Título 2. El pasaje y el turismo
  // foráneo son materia de la RFA 3.12 (citada como excepción distinta en
  // `normas/lisr-27-III.yaml`), que NO tiene ficha en este repo. Contestar
  // «sí» aquí abre la facilidad del 15%: una flota de pasaje/turismo que
  // respondiera que sí quedaba declarada elegible sin serlo. Fail-closed:
  // deja de abrir la 2.9 para pasaje/turismo hasta que exista ficha 3.12.
  {
    id: 'dedicacionExclusivaCarga',
    titulo: 'Dedicación exclusiva',
    pregunta: '¿La flota se dedica exclusivamente al autotransporte terrestre de carga federal?',
    porQue: 'Es la válvula de la facilidad del 15% de combustible en efectivo (RFA 2.9) y una condición del estímulo de peaje.',
    sustento: {
      cita: 'RFA 2026 regla 2.9',
      normaId: 'rfa-2026-2.9',
      texto: 'La facilidad del 15% exige dedicación EXCLUSIVA al autotransporte terrestre de carga federal y tributar en los regímenes que la regla lista. Sin declaración, el efectivo en combustible sale a revisión: no se afirma que sí, ni que no.',
    },
    chips: SI_NO,
    requeridaParaPanel: false,
  },
  {
    id: 'transporteDedicado',
    titulo: 'Transporte dedicado',
    pregunta: '¿Hacen transporte dedicado (un solo cliente manda la carga, no se consolida con la de otros)?',
    porQue: 'La RMF 2.7.7.1.3 invierte los roles del complemento Carta Porte: quién es el que transporta y quién el que figura como cliente.',
    sustento: {
      cita: 'RMF 2026 regla 2.7.7.1.3',
      normaId: 'rmf-2026-2.7.7',
      texto: 'En transporte dedicado los roles del complemento se invierten. El corpus lo advierte; esta pregunta existe para no aplicar la regla general a quien no le toca. Si no aplica, dilo: no se infiere del RFC.',
    },
    chips: SI_NO,
    requeridaParaPanel: false,
  },
  {
    id: 'hombreCamion',
    titulo: 'Hombre-camión',
    pregunta: '¿Hay hombre-camión — el dueño maneja su propia unidad?',
    porQue: 'Con hombre-camión los viáticos son práctica fiscal indebida, y el criterio alcanza también al proveedor de software.',
    sustento: {
      cita: 'Criterio 6/ISR/PI',
      normaId: null,
      texto: 'Criterio no vinculativo del Anexo 3 de la RMF 2026. No hay ficha transcrita en normas/: se pregunta para no inducir viáticos indebidos, no para afirmar un veredicto. Si no estás seguro, déjalo pendiente.',
    },
    chips: SI_NO,
    requeridaParaPanel: false,
  },
  {
    id: 'tarjetasANombreEmpresa',
    titulo: 'Tarjetas a nombre de la empresa',
    pregunta: 'Cuando pagan con tarjeta o monedero, ¿están a nombre de la empresa (no del chofer ni de un tercero)?',
    porQue: 'LIF 2026 art. 20-A fracción IV lo pide en literal para el estímulo de IEPS al diésel. “Con la suya y le reembolsamos” tumba el estímulo, y ningún ticket lo revela.',
    sustento: {
      cita: 'LIF 2026 art. 20-A fr. IV',
      normaId: 'lif-2026-art-20-A',
      texto: 'El medio de pago electrónico tiene que ser de la cuenta del contribuyente. Si el chofer paga con su tarjeta personal, no se afirma el estímulo aunque el XML diga 04 o 28.',
    },
    chips: SI_NO,
    requeridaParaPanel: false,
  },
  {
    id: 'pagoEnBomba',
    titulo: 'Quién paga en la bomba',
    pregunta: 'Cuando el operador carga diésel en carretera, ¿con qué paga: tarjeta/monedero de la empresa, el suyo y se le reembolsa, o depende del viaje?',
    porQue: 'Ningún ticket dice de quién era la tarjeta. Si es reembolso al chofer, el IEPS de esa carga no se acredita aunque el papel se vea impecable.',
    sustento: {
      cita: 'LIF 2026 art. 20-A fr. IV · LISR 27-III',
      normaId: 'lisr-27-fr-III',
      texto: 'La clasificación del comprobante sigue siendo por el CFDI, no por esta respuesta. Esta declaración evita tratar un reembolso como pago empresarial.',
    },
    chips: [
      { valor: 'empresa', etiqueta: 'Tarjeta o monedero de la empresa' },
      { valor: 'chofer_reembolso', etiqueta: 'El chofer pone y se le reembolsa' },
      { valor: 'mixto', etiqueta: 'Depende del viaje' },
      { valor: 'no_se', etiqueta: 'No lo sé todavía' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'creditoEstacion',
    titulo: 'Crédito con la estación',
    pregunta: '¿Compran a crédito con alguna estación de casa (les facturan PPD y pagan después, con complemento de pago)?',
    porQue: 'Un CFDI con FormaPago 99 no acredita IVA hasta que llega el REP. Sin esta declaración el IVA de esa estación se da por perdido en silencio.',
    sustento: {
      cita: 'LIVA art. 5 fr. III',
      normaId: 'liva-art-5',
      texto: 'El IVA tiene que estar efectivamente pagado en el mes. El motor ya excluye el 99; lo que falta es esperar el complemento. Si no hay crédito, no se inventa.',
    },
    chips: SI_NO,
    requeridaParaPanel: false,
  },
  {
    id: 'casetasRedNacional',
    titulo: 'Casetas de la Red Nacional',
    pregunta: '¿Las casetas que recorren son de la Red Nacional de Autopistas de Cuota? Likida NO lo verifica: lo declaras tú. El estímulo de peaje del 50% no aplica fuera de esa red.',
    porQue: 'LIF 2026 20-A + RMF 9.1.8. Un “sí” cómodo acreditaría 50% de casetas que no califican.',
    sustento: {
      cita: 'LIF 2026 art. 20-A · RMF 9.1.8',
      normaId: 'rmf-2026-9.1.8',
      texto: 'Si no estás seguro, déjalo pendiente. El motor no infiere la red por el nombre de la caseta.',
    },
    chips: SI_NO,
    requeridaParaPanel: false,
  },
  {
    id: 'gps',
    titulo: 'GPS',
    pregunta: '¿Qué GPS o rastreador usan hoy? Si no está en la lista, dímelo con su nombre — no voy a inventar un conector que Likida no sepa enchufar.',
    porQue: 'Para no volver a pedir un dato que el GPS ya tiene, y para no encender un conector que no usan.',
    sustento: { cita: 'Catálogo de conectores de Likida', normaId: null, texto: 'Solo se guarda un id del catálogo, o «ninguno», o «otro» con el nombre que escribiste. Un sistema que no está aquí no se finge conectado.' },
    chips: [
      { valor: 'ninguno', etiqueta: 'No usamos GPS' },
      { valor: 'wialon', etiqueta: 'Wialon' },
      { valor: 'samsara', etiqueta: 'Samsara' },
      { valor: 'geotab', etiqueta: 'Geotab' },
      { valor: 'navixy', etiqueta: 'Navixy' },
      { valor: 'otro', etiqueta: 'Otro' },
      { valor: 'no_se', etiqueta: 'No lo sé todavía' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'erp',
    titulo: 'ERP / contabilidad',
    pregunta: '¿Con qué sistema llevan la contabilidad o el ERP?',
    porQue: 'Decide qué conector encender y qué no volver a pedir.',
    sustento: { cita: 'Catálogo de conectores de Likida', normaId: null, texto: 'Igual que el GPS: id del catálogo, ninguno, u otro. No se inventa un SAP que no está.' },
    chips: [
      { valor: 'ninguno', etiqueta: 'No usamos' },
      { valor: 'contpaqi', etiqueta: 'CONTPAQi' },
      { valor: 'aspel_coi', etiqueta: 'Aspel COI' },
      { valor: 'odoo', etiqueta: 'Odoo' },
      { valor: 'sap_b1', etiqueta: 'SAP Business One' },
      { valor: 'archivo_contable', etiqueta: 'Archivo / Excel' },
      { valor: 'otro', etiqueta: 'Otro' },
      { valor: 'no_se', etiqueta: 'No lo sé todavía' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'tms',
    titulo: 'TMS / despacho',
    pregunta: '¿Qué sistema usan para despachar viajes (TMS)? Si no hay, dímelo: no voy a fingir un conector.',
    porQue: 'Para no volver a pedir origen, destino y unidad que el TMS ya tiene. Hoy Likida captura el viaje; no planea.',
    sustento: { cita: 'Catálogo de conectores de Likida', normaId: null, texto: 'Id del catálogo, ninguno, u otro. Un TMS que no está aquí no se finge conectado.' },
    chips: [
      { valor: 'ninguno', etiqueta: 'No usamos TMS' },
      { valor: 'tms_generico', etiqueta: 'Otro TMS (escríbelo)' },
      { valor: 'no_se', etiqueta: 'No lo sé todavía' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'tag',
    titulo: 'TAG de peaje',
    pregunta: '¿Qué TAG de casetas usan (IAVE, PASE, TeleVía…)?',
    porQue: 'Con el archivo de cruces se deja de pedir foto de cada caseta.',
    sustento: { cita: 'Catálogo de conectores de Likida', normaId: null, texto: 'Ningún TAG publica API para terceros. Lo que sí existe es el desglose de cruces. Guardar la marca no enciende una API inventada.' },
    chips: [
      { valor: 'ninguno', etiqueta: 'No usamos TAG' },
      { valor: 'iave', etiqueta: 'IAVE' },
      { valor: 'pase', etiqueta: 'PASE' },
      { valor: 'televia', etiqueta: 'TeleVía' },
      { valor: 'otro', etiqueta: 'Otro' },
      { valor: 'no_se', etiqueta: 'No lo sé todavía' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'monedero',
    titulo: 'Monedero de diésel',
    pregunta: '¿Con qué monedero de diésel cargan (Edenred, Sí Vale, PowerGAS, Efectivale…)? Si no usan, dímelo: no voy a tratar los tickets de bomba como si fueran de monedero.',
    porQue: 'RMF 3.3.1.7: si hay monedero, la gasolinera no puede facturar esa carga. El ticket es evidencia operativa; el CFDI lo emite el monedero.',
    sustento: {
      cita: 'RMF 3.3.1.7',
      normaId: 'rmf-2026-3.3.1.7',
      texto: 'Declarar el monedero no clasifica comprobantes por sí solo — eso lo hace el RFC o la línea ECC. Sirve para no volver a preguntar y para saber qué archivo esperar.',
    },
    chips: [
      { valor: 'ninguno', etiqueta: 'No usamos monedero' },
      { valor: 'monedero_diesel', etiqueta: 'Monedero (Edenred / Sí Vale / otro del padrón)' },
      { valor: 'powergas', etiqueta: 'PowerGAS' },
      { valor: 'otro', etiqueta: 'Otro' },
      { valor: 'no_se', etiqueta: 'No lo sé todavía' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'portalFacturacion',
    titulo: 'Portales de facturación',
    pregunta: '¿De qué cadenas facturan tickets con más frecuencia (PEMEX, ARCO, OXXO, CAPUFE…)? Si facturan a mano o no lo saben, dímelo. El motor identifica el portal por el ticket; esto sirve para no prometter un portal que no usamos.',
    porQue: 'El agente de facturas entra al portal del comercio. Declarar la cadena no inventa un login: las credenciales van en Conexiones.',
    sustento: { cita: 'Catálogo de portales de Likida', normaId: 'politica-portales-plazos-facturacion', texto: 'Los plazos de facturación son política del comercio (nivel 6), no ley. Si no estás seguro, se infiere del ticket.' },
    chips: [
      { valor: 'ninguno', etiqueta: 'Facturamos a mano / no sé' },
      { valor: 'otro', etiqueta: 'Te digo las cadenas' },
      { valor: 'no_se', etiqueta: 'Que lo infiera de los tickets' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'pagoOperador',
    titulo: 'Pago al operador',
    pregunta: '¿Cómo le pagan al operador: por viaje, por kilómetro o sueldo?',
    porQue: 'Cambia el cálculo del agente de conductores. Ningún ticket lo revela.',
    sustento: { cita: 'Hecho operativo, no una norma', normaId: null, texto: 'No hay artículo que lo imponga. Se pregunta porque el sistema no puede inferirlo del CFDI.' },
    chips: [
      { valor: 'viaje', etiqueta: 'Por viaje' },
      { valor: 'km', etiqueta: 'Por kilómetro' },
      { valor: 'sueldo', etiqueta: 'Sueldo' },
      { valor: 'no_se', etiqueta: 'No lo sé todavía' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'tanquePropio',
    titulo: 'Tanque propio',
    pregunta: '¿Tienen tanque propio en la base?',
    porQue: 'El umbral de exposición de hidrocarburos (75,714 L/mes) cambia si despachan de tanque propio.',
    sustento: { cita: 'Exposición de hidrocarburos', normaId: null, texto: 'Es una pregunta de exposición, no un veredicto. Un no inventado sería tan caro como un sí inventado: si no lo sabes, se deja pendiente.' },
    chips: SI_NO,
    requeridaParaPanel: false,
  },
  {
    id: 'topesPolitica',
    titulo: 'Topes de gasto por viaje',
    pregunta: '¿Cuánto puede gastar un operador por viaje, en pesos, en diésel, caseta, comida y hotel? Ejemplo: «diésel 4000, caseta 1500, comida 800, hotel 2500». Son TOPES DE LA FLOTA, no de la ley: el motor marca lo que se pasa. La ley (LISR 28-V $750/día de comida, LISR 27-III $2,000 efectivo no combustible) se aplica aparte y no se toca aquí.',
    porQue: 'Sin política propia, el motor usa los números de la demo. No son los de ustedes hasta que los declaren.',
    sustento: { cita: 'Política interna de la flota (no es ley)', normaId: null, texto: 'Exceder el tope de la flota no vuelve el gasto no deducible ante el SAT. Son dos juicios distintos. Si no los tienes, se deja el de demo marcado como default, no como declarado.' },
    chips: [
      { valor: 'topes-demo', etiqueta: 'Diésel 4,000 · caseta 1,500 · comida 800 · hotel 2,500' },
      { valor: 'no_se', etiqueta: 'Los cargo después en Políticas' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'operadoresAlta',
    titulo: 'Operadores (WhatsApp)',
    pregunta: 'Para que el chofer mande fotos de tickets por WhatsApp necesito al menos un operador con su teléfono a 10 dígitos. Escríbelos: «Juan Pérez 5512345678, María López 5587654321». Sin teléfono el bot no lo reconoce.',
    porQue: 'El webhook identifica al chofer por el número. Dos flotas con el mismo teléfono se niegan: los comprobantes irían a la flota equivocada.',
    sustento: { cita: 'Canal WhatsApp de Likida', normaId: null, texto: 'Se da de alta en `operador` con lada 52. Si los vas a cargar en el panel, dímelo: no invento una plantilla de choferes.' },
    chips: [{ valor: 'no_se', etiqueta: 'Los cargo después en Operadores' }],
    requeridaParaPanel: false,
  },
  {
    id: 'unidadesAlta',
    titulo: 'Unidades',
    pregunta: '¿Placas o número económico de las unidades que van a viajar? Ejemplo: «ECO-12 ABC-12-34, ECO-13 XYZ-98-76». Sin catálogo el motor usa un rendimiento de demo (~3 km/L) y no afirma el de tu tracto.',
    porQue: 'La desviación de diésel se mide contra el rendimiento de la unidad. Un default de demo no es el de ustedes.',
    sustento: { cita: 'Catálogo de unidades', normaId: null, texto: 'Póliza, permiso SICT y verificación se pueden cargar después. No invento vigencias.' },
    chips: [{ valor: 'no_se', etiqueta: 'Las cargo después en Unidades' }],
    requeridaParaPanel: false,
  },
  {
    id: 'telefonoJefe',
    titulo: 'Teléfono del jefe de flota',
    pregunta: '¿A qué WhatsApp (10 dígitos) avisamos cuando un viaje se escala o un chofer no confirma? Si ya está el tuyo de dueño, dímelo. Si hay un encargado de patio, su número.',
    porQue: 'Sin este número, el aviso de operación no tiene a quién escribirle. El de dinero (cierre con cifras) va aparte, a quien ve dinero.',
    sustento: { cita: 'Cadena de escalamiento', normaId: null, texto: 'No se usa el teléfono de otra flota como fallback.' },
    chips: [{ valor: 'no_se', etiqueta: 'Usa el mío de dueño' }],
    requeridaParaPanel: false,
  },
  {
    id: 'cobranzaVentana',
    titulo: 'Horario de recordatorios',
    pregunta: '¿En qué horario (hora de México) le recordamos a los operadores que faltan comprobantes? Por ejemplo: 9 a 18, lunes a sábado.',
    porQue: 'El agente de cobranza no escribe de madrugada ni en domingo salvo que lo declares. La ventana es del chofer, no del servidor.',
    sustento: { cita: 'Paso 6 del perfil operativo', normaId: null, texto: 'Hoy vive en una tabla aparte. Migrarlo al perfil evita que un agente nuevo se construya encima de esa deriva. Si no lo dices, se mantiene el default 9–18 lun–sáb — y se marca como default, no como declarado.' },
    chips: [
      { valor: '9-18-lv', etiqueta: '9 a 18, lunes a viernes' },
      { valor: '9-18-ls', etiqueta: '9 a 18, lunes a sábado' },
      { valor: '8-20-ls', etiqueta: '8 a 20, lunes a sábado' },
      { valor: 'no_se', etiqueta: 'Dejar el horario de siempre' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'ordenAviso',
    titulo: 'A quién avisar',
    pregunta: 'Cuando hay que escalar un viaje o avisar algo de operación, ¿a quién le escribimos primero?',
    porQue: 'El default es el encargado y luego el dueño. Avisarle al dueño de cada ticket lo entrena a ignorar el canal. El contador no despacha.',
    sustento: { cita: 'Paso 6 — ORDEN_AVISO', normaId: null, texto: 'Los avisos de DINERO (cierre con cifras) van aparte, al dueño y al contador: el encargado no ve dinero en el panel y WhatsApp no puede ser la puerta trasera.' },
    chips: [
      { valor: 'encargado_dueno', etiqueta: 'Encargado, luego yo (dueño)' },
      { valor: 'dueno_encargado', etiqueta: 'Yo primero, luego el encargado' },
      { valor: 'solo_dueno', etiqueta: 'Solo yo' },
      { valor: 'solo_encargado', etiqueta: 'Solo el encargado' },
      { valor: 'no_se', etiqueta: 'Dejar el orden de siempre' },
    ],
    requeridaParaPanel: false,
  },
  {
    id: 'hazmat',
    titulo: 'Materiales peligrosos',
    pregunta: '¿Mueven materiales peligrosos (Clase 1 a 9)? Si no, dímelo: no voy a encender el protocolo SETIQ / ASEA 6 h por si acaso.',
    porQue: 'Con hazmat el protocolo de asistencia cambia entero: SETIQ 800 002 1400 (sin WhatsApp), relojes de 6 h y 3 días. Se infiere también de ClaveProdServ + Carta Porte cuando lleguen viajes; esta pregunta adelanta el protocolo.',
    sustento: { cita: 'NOM-005 · RTTMRP 57 Bis · ASEA', normaId: null, texto: 'Si no estás seguro, el sistema lo verá en la carta porte. Un sí inventado despacha un protocolo que no les toca.' },
    chips: SI_NO,
    requeridaParaPanel: false,
  },
  {
    id: 'poliza',
    titulo: 'Póliza y 800 de siniestros',
    pregunta: '¿Aseguradora, número de póliza y el 800 de siniestros? Ejemplo: «Qualitas 800 800 2882 póliza 12345». Hoy `unidad.poliza_vence` es una fecha suelta: el agente de asistencia necesita el 800, no la fecha.',
    porQue: 'Likida NUNCA marca a la aseguradora ni al 911. El 800 se le dice al jefe. Un número inventado es peor que no tenerlo.',
    sustento: { cita: 'Directorio de emergencia de la flota', normaId: null, texto: 'Se pide con plazo si hay que buscar el papel. No se bloquea el alta.' },
    chips: [{ valor: 'no_se', etiqueta: 'La busco y te la mando' }],
    requeridaParaPanel: false,
  },
  {
    id: 'emailFacturacion',
    titulo: 'Correo para CFDIs',
    pregunta: '¿A qué correo mandamos el CFDI cuando Likida te factura, y a dónde reenvían el XML del monedero/TAG si no llega por WhatsApp?',
    porQue: 'El correo no impide timbrar; impide que el papel llegue. El XML del consolidado (ECC) es el comprobante deducible del monedero (RMF 3.3.1.7), no la foto del ticket.',
    sustento: { cita: 'RMF 3.3.1.7 · CFDI 4.0', normaId: 'rmf-2026-3.3.1.7', texto: 'Un correo mal escrito no se “adivina”. Si no lo tienes, el panel de suscripción lo pide después.' },
    chips: [{ valor: 'no_se', etiqueta: 'Lo pongo después' }],
    requeridaParaPanel: false,
  },
];

export const CATALOGO_POR_ID: Record<CampoEntrevista, PreguntaEntrevista> = Object.fromEntries(
  CATALOGO.map((p) => [p.id, p]),
) as Record<CampoEntrevista, PreguntaEntrevista>;

function yaDeclarado(perfil: unknown, id: CampoEntrevista): boolean {
  const umbral = umbralPeajeDeclarado(perfil);
  // Las dos del umbral son el candado del panel: "no sé" NO cuenta — hay
  // que volver a preguntar. El resto acepta `ausente` (se preguntó, no supo).
  if (id === 'ingresosMenoresA300M') return umbral.ingresosMenoresA300M !== null;
  if (id === 'parteRelacionada') return umbral.parteRelacionada !== null;
  return campoBooleanoDeclarado(perfil, id);
}

function campoBooleanoDeclarado(perfil: unknown, id: CampoEntrevista): boolean {
  if (!perfil || typeof perfil !== 'object') return false;
  const c = (perfil as Record<string, unknown>)[id];
  if (!c || typeof c !== 'object') return false;
  const proc = (c as { procedencia?: unknown }).procedencia;
  // `ausente` = se preguntó y no supo. No se actúa (decidir lo ignora) y
  // no se vuelve a preguntar. `inferido`/`default` SÍ se re-preguntan.
  return proc === 'declarado' || proc === 'detectado' || proc === 'ausente';
}

export interface EstadoEntrevista {
  perfilListo: boolean;
  elegiblePeaje: boolean | null;
  pendientes: PreguntaEntrevista[];
  siguiente: PreguntaEntrevista | null;
  declaradas: CampoEntrevista[];
}

export function estadoEntrevista(perfilCrudo: unknown): EstadoEntrevista {
  const declaradas: CampoEntrevista[] = [];
  const pendientes: PreguntaEntrevista[] = [];
  for (const p of CATALOGO) {
    if (yaDeclarado(perfilCrudo, p.id)) declaradas.push(p.id);
    else pendientes.push(p);
  }
  return {
    perfilListo: onboardingFiscalListo(perfilCrudo),
    elegiblePeaje: calificaEstimuloPeaje(perfilCrudo).elegible,
    pendientes,
    siguiente: pendientes[0] ?? null,
    declaradas,
  };
}

function esNoSe(t: string): boolean {
  const s = strip(t);
  return /^(no se|no lo se|no estoy seguro|despues|mas tarde|ahorita no|dejalo|omitir|skip|no aplica\??)$/.test(s)
    || s === 'no_se';
}

function parseSiNo(t: string): boolean | undefined {
  const s = strip(t);
  if (s === 'si' || s === 'sip' || s === 'claro' || s === 'correcto' || s === 'afirmativo' || s === 'exacto') return true;
  if (s === 'no' || s === 'nop' || s === 'negativo' || s === 'nunca') return false;
  if (/^(si|sip)\b/.test(s) && !/\bno\b/.test(s)) return true;
  if (/^no\b/.test(s) && !/\bsi\b/.test(s)) return false;
  return undefined;
}

function parseIngresos(t: string): boolean | undefined {
  const s = strip(t);
  if (s === 'menor' || s === 'menores') return true;
  if (s === 'mayor' || s === 'mayores') return false;
  if (/menos de 300|menores? (a|de) ?\$?300|abajo de 300|no llegamos a 300|bajos/.test(s)) return true;
  if (/mas de 300|arriba de 300|300 millones o mas|superamos|mayores? (a|de) ?\$?300/.test(s)) return false;
  // Un «sí» no es «menores a $300M». Los chips son menor/mayor/no_se.
  return undefined;
}

function parseConector(t: string, categoria: 'Rastreo GPS' | 'ERP y contabilidad' | 'Peaje y monederos' | 'Portal de facturación', idsExtra: string[]): string | undefined {
  const s = strip(t);
  if (s === 'ninguno' || s === 'no usamos' || s === 'no tenemos' || s === 'ninguna') return 'ninguno';
  const lista = CONECTORES.filter((c) => c.categoria === categoria || idsExtra.includes(c.id));
  for (const c of lista) {
    if (s === strip(c.id) || s === strip(c.nombre)) return c.id;
  }
  if (s === 'otro') return 'otro';
  // Un nombre que no está en el catálogo: se guarda como otro, no se inventa id.
  if (s.length >= 2 && !esNoSe(t) && parseSiNo(t) === undefined) return `otro:${t.trim().slice(0, 80)}`;
  return undefined;
}

function parseVentana(t: string): DatosOnboarding['cobranzaVentana'] | undefined {
  const s = strip(t);
  if (s === '9-18-lv') return { horaInicio: 9, horaFin: 18, diasSemana: [1, 2, 3, 4, 5] };
  if (s === '9-18-ls') return { horaInicio: 9, horaFin: 18, diasSemana: [1, 2, 3, 4, 5, 6] };
  if (s === '8-20-ls') return { horaInicio: 8, horaFin: 20, diasSemana: [1, 2, 3, 4, 5, 6] };
  const hm = s.match(/\b(\d{1,2})\s*(?::00)?\s*(?:a|hasta|-|–)\s*(\d{1,2})\b/);
  if (!hm) return undefined;
  const horaInicio = Number(hm[1]);
  const horaFin = Number(hm[2]);
  if (!Number.isInteger(horaInicio) || !Number.isInteger(horaFin) || horaFin <= horaInicio) return undefined;
  if (horaInicio < 0 || horaInicio > 23 || horaFin < 1 || horaFin > 24) return undefined;
  let diasSemana = [1, 2, 3, 4, 5, 6];
  if (/lunes a viernes|lun a vie|entre semana/.test(s)) diasSemana = [1, 2, 3, 4, 5];
  else if (/todos los dias|lunes a domingo/.test(s)) diasSemana = [1, 2, 3, 4, 5, 6, 7];
  else if (/lunes a sabado/.test(s)) diasSemana = [1, 2, 3, 4, 5, 6];
  return { horaInicio, horaFin, diasSemana };
}

const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

function parseRfc(t: string): string | undefined {
  const hit = t.toUpperCase().match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}/);
  if (!hit || !RFC_RE.test(hit[0])) return undefined;
  return hit[0];
}

function parseCp(t: string): string | undefined {
  const m = t.match(/\b(\d{5})\b/);
  return m ? m[1] : undefined;
}

function parseRegimenSat(t: string): string | undefined {
  const s = strip(t);
  const claves = ['601', '603', '612', '621', '624', '626'];
  if (claves.includes(t.trim())) return t.trim();
  if (/resico/.test(s)) return '626';
  if (/coordinad/.test(s)) return '624';
  if (/persona moral|general de ley|sa de cv/.test(s)) return '601';
  if (/persona fisica|activid(ad|ades) empresarial/.test(s)) return '612';
  return undefined;
}

function parseEmail(t: string): string | undefined {
  const m = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : undefined;
}

function parseTopes(t: string): DatosOnboarding['topesPolitica'] | undefined {
  const s = strip(t);
  if (s === 'topes-demo') return { diesel: 4000, caseta: 1500, alimentacion: 800, hospedaje: 2500 };
  const num = (k: string): number | undefined => {
    const m = s.match(new RegExp(`${k}\\s*:?\\s*\\$?\\s*(\\d{3,6})`));
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const diesel = num('diesel');
  const caseta = num('caseta') ?? num('casetas') ?? num('peaje');
  const alimentacion = num('comida') ?? num('alimentacion') ?? num('viatico');
  const hospedaje = num('hotel') ?? num('hospedaje');
  if (diesel === undefined && caseta === undefined && alimentacion === undefined && hospedaje === undefined) return undefined;
  return { diesel, caseta, alimentacion, hospedaje };
}

function parseOperadores(t: string): Array<{ nombre: string; telefono: string }> | undefined {
  const out: Array<{ nombre: string; telefono: string }> = [];
  const re = /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ .'-]{1,40}?)\s+(?:\+?52)?[\s-]*(\d{10})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    out.push({ nombre: m[1].trim(), telefono: m[2] });
  }
  return out.length > 0 ? out : undefined;
}

function parseUnidades(t: string): Array<{ economico: string; placas?: string }> | undefined {
  const partes = t.split(/[,;]| y /i).map((p) => p.trim()).filter(Boolean);
  const out: Array<{ economico: string; placas?: string }> = [];
  for (const p of partes) {
    const tokens = p.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens.length === 1) out.push({ economico: tokens[0].slice(0, 20) });
    else out.push({ economico: tokens[0].slice(0, 20), placas: tokens.slice(1).join('').slice(0, 12) });
  }
  return out.length > 0 ? out : undefined;
}

function parseTel(t: string): string | undefined {
  const d = t.replace(/[^\d]/g, '');
  if (d.length === 10) return d;
  if (d.length === 12 && d.startsWith('52')) return d.slice(2);
  return undefined;
}

function parsePoliza(t: string): DatosOnboarding['poliza'] | undefined {
  const s = t.trim();
  if (s.length < 3) return undefined;
  const tel = s.match(/800[\s-]?\d{3}[\s-]?\d{3,4}/);
  const num = s.match(/poliza\s+([A-Z0-9-]{3,20})/i);
  const aseguradora = s.replace(/800[\s-]?\d{3}[\s-]?\d{3,4}/, '').replace(/poliza\s+[A-Z0-9-]{3,20}/i, '').trim() || s;
  return { aseguradora: aseguradora.slice(0, 80), numero: num?.[1], telefono800: tel?.[0]?.replace(/\s+/g, '') };
}

function parseOrden(t: string): RolAviso[] | undefined {
  const s = strip(t);
  if (s === 'encargado_dueno' || /encargado.*luego.*(dueno|yo|admin)/.test(s) || s === 'el encargado primero') {
    return ['encargado', 'flota_admin'];
  }
  if (s === 'dueno_encargado' || /yo primero|dueno primero|a mi primero/.test(s)) {
    return ['flota_admin', 'encargado'];
  }
  if (s === 'solo_dueno' || /solo yo|solo el dueno|nada mas a mi/.test(s)) return ['flota_admin'];
  if (s === 'solo_encargado' || /solo el encargado/.test(s)) return ['encargado'];
  return undefined;
}

function parseCampo(id: CampoEntrevista, texto: string): Parseo {
  if (esNoSe(texto)) return { ok: false, motivo: 'no_se', detalle: 'Queda pendiente. No se inventa un no.' };
  switch (id) {
    case 'ingresosMenoresA300M': {
      const v = parseIngresos(texto);
      if (v === undefined) return { ok: false, motivo: 'ambiguo', detalle: 'Necesito saber si fueron menores a $300 millones, o $300 millones o más.' };
      return { ok: true, hechos: { ingresosMenoresA300M: v } };
    }
    case 'parteRelacionada': {
      const v = parseSiNo(texto);
      if (v === undefined) return { ok: false, motivo: 'ambiguo', detalle: '¿Es parte relacionada, sí o no? Si no estás seguro, dímelo y lo dejamos pendiente.' };
      return { ok: true, hechos: { parteRelacionada: v } };
    }
    case 'dedicacionExclusivaCarga': {
      const v = parseSiNo(texto);
      if (v === undefined) return { ok: false, motivo: 'ambiguo', detalle: '¿Dedicación exclusiva, sí o no?' };
      return { ok: true, hechos: { dedicacionExclusivaCarga: v } };
    }
    case 'rfcEmpresa': {
      const v = parseRfc(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Necesito el RFC de 12 o 13 caracteres, tal cual la constancia. No lo invento.' };
      return { ok: true, hechos: { rfcEmpresa: v } };
    }
    case 'razonSocial': {
      const s = texto.trim();
      if (s.length < 3 || parseSiNo(texto) !== undefined) {
        return { ok: false, motivo: 'ambiguo', detalle: 'Escríbela tal cual la constancia, sin abreviar de más.' };
      }
      return { ok: true, hechos: { razonSocial: s.slice(0, 254) } };
    }
    case 'regimenSat': {
      const v = parseRegimenSat(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Elige la clave SAT (612, 601, 626, 624…) o descríbela. No un “sí califico”.' };
      const elegible = v === '612' || v === '624';
      return { ok: true, hechos: { regimenSat: v, regimenElegible: elegible } };
    }
    case 'codigoPostalFiscal': {
      const v = parseCp(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Cinco dígitos del CP fiscal, no el del patio.' };
      return { ok: true, hechos: { codigoPostalFiscal: v } };
    }
    case 'tarjetasANombreEmpresa': {
      const v = parseSiNo(texto);
      if (v === undefined) return { ok: false, motivo: 'ambiguo', detalle: '¿Las tarjetas están a nombre de la empresa, sí o no?' };
      return { ok: true, hechos: { tarjetasANombreEmpresa: v } };
    }
    case 'pagoEnBomba': {
      const s = strip(texto);
      const v = s === 'empresa' || /tarjeta (de )?la empresa|monedero de la empresa/.test(s) ? 'empresa' as const
        : s === 'chofer_reembolso' || /reembols|el (pone|paga) (el )?chofer|con la suya/.test(s) ? 'chofer_reembolso' as const
        : s === 'mixto' || /depende|a veces/.test(s) ? 'mixto' as const
        : undefined;
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: '¿Paga la empresa, el chofer con reembolso, o depende?' };
      return { ok: true, hechos: { pagoEnBomba: v } };
    }
    case 'creditoEstacion': {
      const v = parseSiNo(texto);
      if (v === undefined) return { ok: false, motivo: 'ambiguo', detalle: '¿Compran a crédito con alguna estación, sí o no?' };
      return { ok: true, hechos: { creditoEstacion: v } };
    }
    case 'casetasRedNacional': {
      const v = parseSiNo(texto);
      if (v === undefined) return { ok: false, motivo: 'ambiguo', detalle: '¿Son de la Red Nacional? Si no estás seguro, mejor pendiente.' };
      return { ok: true, hechos: { casetasRedNacional: v } };
    }
    case 'tms': {
      const v = parseConector(texto, 'ERP y contabilidad', ['tms_generico']);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Dime el TMS o que no usan.' };
      return hechosStack('tms', v);
    }
    case 'portalFacturacion': {
      const s = strip(texto);
      if (s === 'ninguno' || /a mano|no facturamos portal/.test(s)) return { ok: true, hechos: { portalFacturacion: 'ninguno' } };
      const v = parseConector(texto, 'Portal de facturación', []);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Dime las cadenas (PEMEX, ARCO, CAPUFE…) o que lo infiera de los tickets.' };
      return hechosStack('portalFacturacion', v);
    }
    case 'topesPolitica': {
      const v = parseTopes(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Ejemplo: «diésel 4000, caseta 1500, comida 800, hotel 2500».' };
      return { ok: true, hechos: { topesPolitica: v } };
    }
    case 'operadoresAlta': {
      const v = parseOperadores(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Nombre y teléfono a 10 dígitos: «Juan Pérez 5512345678».' };
      return { ok: true, hechos: { operadoresAlta: v } };
    }
    case 'unidadesAlta': {
      const v = parseUnidades(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Económico y placas: «ECO-12 ABC-12-34».' };
      return { ok: true, hechos: { unidadesAlta: v } };
    }
    case 'telefonoJefe': {
      const v = parseTel(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Diez dígitos, sin lada 52 o con ella.' };
      return { ok: true, hechos: { telefonoJefe: v } };
    }
    case 'hazmat': {
      const v = parseSiNo(texto);
      if (v === undefined) return { ok: false, motivo: 'ambiguo', detalle: '¿Mueven materiales peligrosos, sí o no?' };
      return { ok: true, hechos: { hazmat: v } };
    }
    case 'poliza': {
      const v = parsePoliza(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Aseguradora y, si lo tienes, el 800 y el número de póliza.' };
      return { ok: true, hechos: { poliza: v } };
    }
    case 'emailFacturacion': {
      const v = parseEmail(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Un correo válido. No adivino el dominio.' };
      return { ok: true, hechos: { emailFacturacion: v } };
    }
    case 'transporteDedicado': {
      const v = parseSiNo(texto);
      if (v === undefined) return { ok: false, motivo: 'ambiguo', detalle: '¿Hacen transporte dedicado, sí o no?' };
      return { ok: true, hechos: { transporteDedicado: v } };
    }
    case 'hombreCamion': {
      const v = parseSiNo(texto);
      if (v === undefined) return { ok: false, motivo: 'ambiguo', detalle: '¿Hay hombre-camión, sí o no?' };
      return { ok: true, hechos: { hombreCamion: v } };
    }
    case 'gps': {
      const v = parseConector(texto, 'Rastreo GPS', ['wialon', 'samsara', 'geotab', 'navixy', 'gps_generico']);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Dime la marca o elige una de las opciones. Si no está, escríbela.' };
      return hechosStack('gps', v);
    }
    case 'erp': {
      const v = parseConector(texto, 'ERP y contabilidad', ['contpaqi', 'aspel_coi', 'odoo', 'sap_b1', 'archivo_contable']);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Dime el sistema de contabilidad o elige una opción.' };
      return hechosStack('erp', v);
    }
    case 'tag': {
      const v = parseConector(texto, 'Peaje y monederos', ['iave', 'pase', 'televia', 'peaje_generico']);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Dime el TAG (IAVE, PASE, TeleVía…) o que no usan.' };
      return hechosStack('tag', v);
    }
    case 'monedero': {
      const v = parseConector(texto, 'Peaje y monederos', ['monedero_diesel', 'powergas']);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Dime el monedero o que no usan. No voy a suponer uno.' };
      return hechosStack('monedero', v);
    }
    case 'pagoOperador': {
      const s = strip(texto);
      const v = s === 'viaje' || /por viaje/.test(s) ? 'viaje'
        : s === 'km' || /kilometr/.test(s) ? 'km'
        : s === 'sueldo' || /salario|nomina/.test(s) ? 'sueldo'
        : undefined;
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: '¿Por viaje, por kilómetro o sueldo?' };
      return { ok: true, hechos: { pagoOperador: v } };
    }
    case 'tanquePropio': {
      const v = parseSiNo(texto);
      if (v === undefined) return { ok: false, motivo: 'ambiguo', detalle: '¿Tienen tanque propio, sí o no?' };
      return { ok: true, hechos: { tanquePropio: v } };
    }
    case 'cobranzaVentana': {
      const v = parseVentana(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: 'Dime hora de inicio y fin, por ejemplo «9 a 18, lunes a sábado».' };
      return { ok: true, hechos: { cobranzaVentana: v } };
    }
    case 'ordenAviso': {
      const v = parseOrden(texto);
      if (!v) return { ok: false, motivo: 'ambiguo', detalle: '¿Encargado primero, tú primero, solo tú o solo el encargado?' };
      return { ok: true, hechos: { ordenAviso: v } };
    }
  }
}

function hechosStack(k: 'gps' | 'erp' | 'tag' | 'monedero' | 'tms' | 'portalFacturacion', v: string): Parseo {
  if (v.startsWith('otro:')) {
    return { ok: true, hechos: { [k]: 'otro', stackOtro: v.slice(5) } };
  }
  return { ok: true, hechos: { [k]: v } };
}

/**
 * Interpreta el turno contra la pregunta de turno. Un "sí" suelto NO rellena
 * las demás. Frases explícitas de OTRO campo («no somos parte relacionada»)
 * sí se recogen, porque el dueño puede contestar dos de un golpe.
 */
export function interpretarTurno(perfilCrudo: unknown, texto: string): {
  hechos: Partial<DatosOnboarding>;
  noSe: CampoEntrevista[];
  ambiguo: string | null;
  preguntaDeTurno: PreguntaEntrevista | null;
} {
  const estado = estadoEntrevista(perfilCrudo);
  const actual = estado.siguiente;
  const hechos: Partial<DatosOnboarding> = {};
  const noSe: CampoEntrevista[] = [];
  let ambiguo: string | null = null;

  if (actual) {
    const r = parseCampo(actual.id, texto);
    if (r.ok) Object.assign(hechos, r.hechos);
    else if (r.motivo === 'no_se') noSe.push(actual.id);
    else ambiguo = r.detalle;
  }

  // Del extracto de un adjunto (CSF, XML): RFC y correo, que tienen forma
  // rígida. La razón social NO se toma de un blob — el SAT la compara letra
  // por letra y un PDF entero no es una razón social. Un sí/no genérico
  // tampoco se infiere de un documento.
  if (estado.pendientes.some((p) => p.id === 'rfcEmpresa') && !('rfcEmpresa' in hechos)) {
    // «RFC emisor» es el de la estación en un ticket, no el de la flota.
    if (!/rfc\s*emisor/i.test(texto)) {
      const v = parseRfc(texto);
      if (v) hechos.rfcEmpresa = v;
    }
  }
  if (estado.pendientes.some((p) => p.id === 'emailFacturacion') && !('emailFacturacion' in hechos)) {
    const v = parseEmail(texto);
    if (v) hechos.emailFacturacion = v;
  }

  // Frases explícitas de otros campos — nunca un sí/no genérico.
  const s = strip(texto);
  if (estado.pendientes.some((p) => p.id === 'parteRelacionada') && !('parteRelacionada' in hechos)) {
    if (/no (somos|es|somos una)? ?parte relacionada/.test(s) || /sin parte relacionada/.test(s)) {
      hechos.parteRelacionada = false;
    } else if (/somos parte relacionada|es parte relacionada/.test(s)) {
      hechos.parteRelacionada = true;
    }
  }
  if (estado.pendientes.some((p) => p.id === 'ingresosMenoresA300M') && !('ingresosMenoresA300M' in hechos) && actual?.id !== 'ingresosMenoresA300M') {
    const v = parseIngresos(texto);
    if (v !== undefined && /300/.test(s)) hechos.ingresosMenoresA300M = v;
  }

  return { hechos, noSe, ambiguo: Object.keys(hechos).length > 0 ? null : ambiguo, preguntaDeTurno: actual };
}

export function mensajeBienvenida(estado: EstadoEntrevista): { texto: string; chips: OpcionChip[]; sustento: PreguntaEntrevista['sustento'] | null } {
  if (estado.perfilListo && !estado.siguiente) {
    return {
      texto: 'El perfil fiscal de la flota ya está declarado. Si algo cambió —ingresos, régimen, monedero, horario— dímelo y lo corrijo. No voy a suponer el resto.',
      chips: [],
      sustento: null,
    };
  }
  const p = estado.siguiente!;
  const intro = estado.perfilListo
    ? 'El umbral de peaje ya está. Seguimos con lo que ningún comprobante revela.\n\n'
    : 'Soy el configurador de Likida. Voy a dejar el software listo para operar: fiscal, con qué sistemas trabajan y la operación (choferes, unidades, topes). No supongo nada: si no lo sabes, queda pendiente.\n\nLo que los tickets revelan (cómo compran diésel, portales, volumen) NO te lo pregunto — el motor lo infiere.\n\nArrancamos por el estímulo de peaje, que hoy se aplica sin condición si no se declara.\n\n';
  return {
    texto: `${intro}${textoPregunta(p)}`,
    chips: p.chips,
    sustento: p.sustento,
  };
}

export function textoPregunta(p: PreguntaEntrevista): string {
  return `${p.titulo}. ${p.pregunta}\n\n${p.porQue}\n\nSustento: ${p.sustento.cita}. ${p.sustento.texto}`;
}

export function mensajeConfirmacion(
  hechos: Partial<DatosOnboarding>,
  estadoDespues: EstadoEntrevista,
): string {
  const lineas: string[] = [];
  if (hechos.ingresosMenoresA300M !== undefined) {
    lineas.push(hechos.ingresosMenoresA300M
      ? 'Quedó declarado: ingresos del último ejercicio menores a $300 millones (LIF 2026 art. 20-A).'
      : 'Quedó declarado: ingresos de $300 millones o más. El estímulo de peaje del 50% no aplica.');
  }
  if (hechos.parteRelacionada !== undefined) {
    lineas.push(hechos.parteRelacionada
      ? 'Quedó declarado: sí es parte relacionada (LISR art. 179). El estímulo de peaje no aplica.'
      : 'Quedó declarado: no es parte relacionada.');
  }
  if (hechos.rfcEmpresa) lineas.push(`RFC: ${hechos.rfcEmpresa}.`);
  if (hechos.razonSocial) lineas.push(`Razón social: ${hechos.razonSocial}.`);
  if (hechos.regimenSat) lineas.push(`Régimen SAT ${hechos.regimenSat}${hechos.regimenElegible === true ? ' (abre la facilidad del 15% si hay dedicación exclusiva)' : hechos.regimenElegible === false ? ' (la facilidad del 15% no aplica)' : ''}.`);
  if (hechos.codigoPostalFiscal) lineas.push(`CP fiscal: ${hechos.codigoPostalFiscal}.`);
  if (hechos.dedicacionExclusivaCarga !== undefined) {
    lineas.push(hechos.dedicacionExclusivaCarga
      ? 'Dedicación exclusiva: sí.'
      : 'Dedicación exclusiva: no. La facilidad del 15% de efectivo no aplica (LISR 27-III sin excepción).');
  }
  if (hechos.transporteDedicado !== undefined) lineas.push(`Transporte dedicado: ${hechos.transporteDedicado ? 'sí' : 'no'}.`);
  if (hechos.hombreCamion !== undefined) lineas.push(`Hombre-camión: ${hechos.hombreCamion ? 'sí' : 'no'}.`);
  if (hechos.tarjetasANombreEmpresa !== undefined) lineas.push(`Tarjetas a nombre de la empresa: ${hechos.tarjetasANombreEmpresa ? 'sí' : 'no'}.`);
  if (hechos.pagoEnBomba) lineas.push(`Pago en bomba: ${hechos.pagoEnBomba}.`);
  if (hechos.creditoEstacion !== undefined) lineas.push(`Crédito con estación: ${hechos.creditoEstacion ? 'sí (el IVA espera el REP)' : 'no'}.`);
  if (hechos.casetasRedNacional !== undefined) lineas.push(`Casetas Red Nacional (declarado, no verificado): ${hechos.casetasRedNacional ? 'sí' : 'no'}.`);
  if (hechos.gps) lineas.push(`GPS: ${hechos.gps}.`);
  if (hechos.erp) lineas.push(`ERP: ${hechos.erp}.`);
  if (hechos.tms) lineas.push(`TMS: ${hechos.tms}.`);
  if (hechos.tag) lineas.push(`TAG: ${hechos.tag}.`);
  if (hechos.monedero) lineas.push(`Monedero: ${hechos.monedero}.`);
  if (hechos.portalFacturacion) lineas.push(`Portales: ${hechos.portalFacturacion}.`);
  if (hechos.stackOtro) lineas.push(`Otro sistema: ${hechos.stackOtro}.`);
  if (hechos.pagoOperador) lineas.push(`Pago al operador: ${hechos.pagoOperador}.`);
  if (hechos.tanquePropio !== undefined) lineas.push(`Tanque propio: ${hechos.tanquePropio ? 'sí' : 'no'}.`);
  if (hechos.topesPolitica) lineas.push(`Topes de flota (no son ley): ${JSON.stringify(hechos.topesPolitica)}.`);
  if (hechos.operadoresAlta) lineas.push(`Operadores para WhatsApp: ${hechos.operadoresAlta.map((o) => o.nombre).join(', ')}.`);
  if (hechos.unidadesAlta) lineas.push(`Unidades: ${hechos.unidadesAlta.map((u) => u.economico).join(', ')}.`);
  if (hechos.telefonoJefe) lineas.push(`Teléfono de escalamiento: ${hechos.telefonoJefe}.`);
  if (hechos.hazmat !== undefined) lineas.push(`Materiales peligrosos: ${hechos.hazmat ? 'sí' : 'no'}.`);
  if (hechos.poliza) lineas.push(`Póliza: ${hechos.poliza.aseguradora}.`);
  if (hechos.emailFacturacion) lineas.push(`Correo de CFDIs: ${hechos.emailFacturacion}.`);
  if (hechos.cobranzaVentana) {
    const v = hechos.cobranzaVentana;
    lineas.push(`Ventana de recordatorios: ${v.horaInicio}:00–${v.horaFin}:00, días ${v.diasSemana.join(',')}.`);
  }
  if (hechos.ordenAviso) lineas.push(`Avisos de operación: ${hechos.ordenAviso.join(' → ')}.`);

  if (estadoDespues.perfilListo && (hechos.ingresosMenoresA300M !== undefined || hechos.parteRelacionada !== undefined)) {
    if (estadoDespues.elegiblePeaje === true) {
      lineas.push('Con eso el motor ya puede aplicar el estímulo de peaje del 50% en el próximo cuadre. Si está mal, dímelo ahora.');
    } else if (estadoDespues.elegiblePeaje === false) {
      lineas.push('Con eso el motor ya NO aplica el 50% de peaje. Si está mal, dímelo ahora.');
    }
  }

  const sig = estadoDespues.siguiente;
  if (sig) {
    lineas.push(`\n${textoPregunta(sig)}`);
  } else {
    lineas.push('\nNo queda nada pendiente de declarar. El software queda listo para operar: los choferes ya pueden mandar fotos de tickets por WhatsApp. Lo que el ticket revela (modalidad de diésel, portales, volumen) el motor lo infiere solo — no te lo vuelvo a preguntar.');
  }
  return lineas.join('\n');
}

export function chipsDe(estado: EstadoEntrevista): OpcionChip[] {
  return estado.siguiente?.chips ?? [];
}
