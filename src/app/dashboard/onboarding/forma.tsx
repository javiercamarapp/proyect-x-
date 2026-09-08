'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Save } from 'lucide-react';
import { Selector, Campo, Aviso, type ResultadoAccion, type AccionDeForma } from '../../admin/ui/forma';

export type Opcion = { valor: string; texto: string };

function Boton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}
      className="text-sm font-medium rounded-lg px-4 py-2 disabled:opacity-60"
      style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
      <span className="inline-flex items-center gap-2">
        <Save width={14} height={14} strokeWidth={1.75} />
        {pending ? 'Guardando…' : 'Guardar perfil de la flota'}
      </span>
    </button>
  );
}

const SI_NO: Opcion[] = [
  { valor: '', texto: 'Elige una' },
  { valor: 'si', texto: 'Sí' },
  { valor: 'no', texto: 'No' },
];

// AUDITORÍA 28 (FIS-C1, mitad quirúrgica): antes esto era un selector sí/no
// que el dueño podía marcar "sí" de buena fe sin saber si su régimen
// realmente califica — la misma puerta que la entrevista conversacional ya
// cerró en entrevista.ts (parseRegimenSat + el cálculo de elegible ahí
// mismo). Aquí se pide la clave SAT real y `regimenElegible` se deriva de
// ella, nunca de lo que el dueño crea que aplica.
const REGIMEN_SAT: Opcion[] = [
  { valor: '', texto: 'Elige una' },
  { valor: '601', texto: '601 — General de Ley Personas Morales' },
  { valor: '603', texto: '603 — Personas Morales con Fines no Lucrativos' },
  { valor: '612', texto: '612 — Personas Físicas con Actividades Empresariales y Profesionales' },
  { valor: '621', texto: '621 — Incorporación Fiscal' },
  { valor: '624', texto: '624 — Coordinados' },
  { valor: '626', texto: '626 — RESICO' },
];

export function FormaOnboarding({
  accion, gps, erp, tag, monedero, inicial,
}: {
  accion: AccionDeForma;
  gps: Opcion[];
  erp: Opcion[];
  tag: Opcion[];
  monedero: Opcion[];
  inicial: {
    ingresos: string;
    parte: string;
    gps: string;
    erp: string;
    tag: string;
    monedero: string;
    pagoOperador: string;
  };
}) {
  const [estado, enviar] = useActionState(accion, null as ResultadoAccion);

  return (
    <form action={enviar} encType="multipart/form-data" className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Fiscal — lo que ningún comprobante revela</h2>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Estas dos son las únicas obligatorias. Sin ellas el estímulo de peaje queda en
          $0 hasta que las contestes — el motor nunca lo acredita sin esta declaración.
          El resto se puede dejar en blanco y completarlo después.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Selector nombre="ingresos" etiqueta="Ingresos anuales del último ejercicio" requerido
            valorInicial={inicial.ingresos}
            opciones={[
              { valor: '', texto: 'Elige una' },
              { valor: 'menor', texto: 'Menores a $300 millones' },
              { valor: 'mayor', texto: '$300 millones o más' },
            ]}
            ayuda="LIF 2026 art. 20-A. $300 millones exactos ya no califican." />
          <Selector nombre="parte" etiqueta="¿Es parte relacionada de otra empresa? (LISR art. 179)" requerido
            valorInicial={inicial.parte} opciones={SI_NO} />
          {/* AUDITORÍA 19 (fiscal F3): la RFA 2026 regla 2.9 exige carga
              FEDERAL específicamente — no cualquier carga (local/municipal
              no califica). Este formulario decía solo "carga", mientras la
              entrevista conversacional (perfil/entrevista.ts) ya decía
              "carga federal" — dos onboardings, dos preguntas distintas
              para la misma facilidad. Una flota de carga local podía
              contestar "sí" de buena fe y quedar declarada elegible al 15%
              sin serlo.
              AUDITORÍA 28 (FIS-M1, MEDIO): esta etiqueta agregó "/ pasaje /
              turismo" en esa misma corrección, y era falso: el texto
              VERIFICADO de la regla 2.9 (normas/rfa-2026-2.9.yaml,
              verificado_fuente_primaria) dice SOLO "carga federal" — igual
              que 2.1 y 2.2. Pasaje y turismo foráneo son materia de la RFA
              3.12, que NO tiene ficha en este repo. Se quita "pasaje /
              turismo" fail-closed: una flota de pasaje/turismo deja de abrir
              la 2.9 hasta que exista ficha 3.12. */}
          <Selector nombre="dedicacion" etiqueta="¿Dedicación exclusiva al autotransporte terrestre de carga federal?"
            opciones={SI_NO} ayuda="RFA 2026 regla 2.9: exige carga FEDERAL específicamente — la carga local/municipal no califica. Válvula del 15% de combustible en efectivo y del estímulo de peaje." />
          <Selector nombre="regimenSat" etiqueta="Régimen fiscal (clave SAT c_RegimenFiscal)"
            opciones={REGIMEN_SAT} ayuda="La facilidad del 15% en efectivo solo abre con 612 o 624 — se calcula de la clave, no de si crees que calificas. Si no estás seguro, déjalo en blanco." />
          <Selector nombre="dedicado" etiqueta="¿Hacen transporte dedicado?"
            opciones={SI_NO} ayuda="La RMF 2.7.7.1.3 invierte los roles del complemento Carta Porte." />
          <Selector nombre="hombreCamion" etiqueta="¿Hay hombre-camión (el dueño maneja)?"
            opciones={SI_NO} ayuda="Con hombre-camión los viáticos son práctica fiscal indebida. Nos protege a los dos." />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Stack — con qué trabajan hoy</h2>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Solo lo que el catálogo de Likida sabe conectar. No se inventa un sistema
          que no esté aquí: si usas otro, márcalo como «Otro» y escríbelo.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Selector nombre="gps" etiqueta="GPS / rastreo" valorInicial={inicial.gps} opciones={gps} />
          <Selector nombre="erp" etiqueta="ERP / contabilidad" valorInicial={inicial.erp} opciones={erp} />
          <Selector nombre="tag" etiqueta="TAG de peaje" valorInicial={inicial.tag} opciones={tag} />
          <Selector nombre="monedero" etiqueta="Monedero de diésel" valorInicial={inicial.monedero} opciones={monedero} />
          <Campo nombre="stackOtro" etiqueta="Si marcaste «Otro», ¿cuál?" placeholder="Nombre del sistema" />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Operación</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Selector nombre="pagoOperador" etiqueta="¿Cómo le pagan al operador?"
            valorInicial={inicial.pagoOperador}
            opciones={[
              { valor: '', texto: 'Elige una' },
              { valor: 'viaje', texto: 'Por viaje' },
              { valor: 'km', texto: 'Por kilómetro' },
              { valor: 'sueldo', texto: 'Sueldo' },
            ]} />
          <Selector nombre="tanquePropio" etiqueta="¿Tienen tanque propio?" opciones={SI_NO} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Políticas de gasto</h2>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Los topes que el motor aplica se capturan en Políticas (montos por concepto).
          Aquí puedes subir además el papel que ya usan (PDF o foto), para que quede
          en la memoria de la flota.
        </p>
        <label className="text-xs" style={{ color: 'var(--muted)' }} htmlFor="politica">
          Documento (PDF, JPEG o PNG, máximo 8 MB)
        </label>
        <input id="politica" type="file" name="politica"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          className="text-[13px] file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:text-[12.5px] file:font-medium"
          style={{ color: 'var(--muted)' }} />
      </section>

      <Aviso estado={estado} />
      <div><Boton /></div>
    </form>
  );
}
