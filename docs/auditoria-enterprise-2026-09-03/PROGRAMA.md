# Programa del bucle enterprise de Likida

**Rama:** `codex/auditoria-enterprise-fix-ci`

**Plan:** `PLAN-EJECUCION-ENTERPRISE.md`

## Condiciones de autonomía

- Salida verificable: cada hallazgo tiene una regresión RED/GREEN, comandos y
  salida capturada.
- Acción reversible: todo ocurre en una rama; cada candidato se aísla en un
  commit y no se despliega automáticamente.
- Horizonte corto: una vuelta atiende un solo hallazgo y dura como máximo 45
  minutos. Una prueba larga es un gate separado, no una vuelta.
- Entorno acotado: cada brief enumera archivos mutables y protegidos.

## Métrica

Métrica primaria: cantidad de P0 y P1 reproducibles abiertos — dirección: baja.

Cómo se lee: el ledger registra por tarea `P0=<n> P1=<n>` después de una
reauditoría independiente. Un hallazgo sólo resta cuando la prueba que lo
reproducía pasa y el reauditor no encuentra una variante equivalente.

Guardias obligatorias:

1. No se elimina, relaja ni marca `skip` una prueba para obtener verde.
2. TypeScript, ESLint ratchet, migraciones desde limpio y suite focal no
   empeoran.
3. Ningún cambio reduce aislamiento tenant, idempotencia, trazabilidad ni
   durabilidad.
4. PASS, FAIL, TRUNCATED, NO-ARTIFACT y SKIPPED permanecen separados.
5. Cero llamadas pagadas o mutaciones de producción durante una vuelta.

## Archivos

- Mutables: únicamente los enumerados en el brief de la tarea activa.
- Protegidos durante la construcción: la regresión RED entregada por el
  auditor, los fixtures de aceptación, este programa y el ledger.
- Protegidos siempre: secretos, datos de producción, `.raw/`, rama principal y
  configuraciones externas de clientes/proveedores.

## Cada vuelta

1. Lee el brief, la regresión RED y la última entrada de la tarea en el ledger.
2. Propone un solo cambio motivado para un hallazgo.
3. Registra el SHA base y aplica el cambio sólo en los archivos mutables.
4. Ejecuta la regresión con un tope de 45 minutos.
5. Si elimina el hallazgo sin romper guardias, conserva el candidato; si no,
   restaura el SHA base y registra por qué fue descartado.
6. Un reauditor con contexto limpio intenta una variante distinta.
7. Registra cambio, comandos, salidas, P0/P1 restantes y veredicto.

Los agentes auditor y reauditor pueden trabajar en paralelo sobre dominios
independientes. Las implementaciones nuevas se integran de una en una para no
atribuir a un cambio el efecto de otro. Las tres construcciones que ya estaban
activas al adoptar este programa terminan como transición y se reauditan antes
de abrir otra implementación.

## Presupuesto

- Máximo por hallazgo: 5 vueltas.
- Máximo por vuelta: 45 minutos.
- Máximo de cambios: uno por vuelta.
- Costo externo por vuelta: 0; sólo dobles controlados y servicios locales.
- GitHub/Vercel: commits intermedios con `[skip ci]`; una corrida integral al
  cierre de la ola.

## Cuándo detenerse y pedir intervención

- Mutar producción, desplegar, rotar secretos, crear/cancelar recursos o hacer
  una llamada que facture dinero.
- Elegir el navegador para la verificación visual/E2E.
- Resolver una decisión fiscal, legal, contractual o de SLA que necesita al
  cliente o a un especialista externo.
- Un hallazgo estructural P0/P1 sigue abierto después de cinco vueltas.

## Crash y recuperación

- Un crash no cuenta como mejora: se conserva su salida, se restaura el mejor
  SHA conocido y se continúa con la siguiente hipótesis.
- El ledger y `git log` son la fuente de recuperación después de compactación o
  reinicio; no se reconstruye el progreso desde memoria conversacional.

## Agotamiento

Si cinco vueltas del mismo hallazgo no bajan P0/P1 sin romper una guardia, el
breaker se abre: se registra el historial, se clasifica el bloqueo y se escala.
Nunca se convierte agotamiento en PASS.

## Salida del programa

El bucle termina sólo cuando la revisión transversal no tiene P0/P1 abiertos y
todos los gates internos aplicables tienen artefacto verificable. Los gates de
proveedor real, pentest, legal/fiscal, on-call y SLA se reportan por separado;
no se inventan para completar una nota.
