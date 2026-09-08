# Progreso — auditoría 29 (8-sep-2026)

Diario de la ronda. Una línea por acción, con su sha cuando la hay. Se escribe
**mientras** avanza, no al cerrar.

## Fase 0 — anclaje

- `git status --porcelain` vacío al arrancar → **autofix habilitado**.
- `list_pull_requests(javiercamarapp/cuadra, open)` → 1 PR abierto, **#409
  `dof-diario: 2026-09-07`**, no es de auditoría. El de la 28 (**#360**) está
  mergeado como `c7bbb83`. → **no aplica continuación**.
- `git log c7bbb83..HEAD -- src/ supabase/ normas/` → **43 commits, 228
  archivos, +10,376 / −1,399** → **no aplica ronda ligera**. → **RONDA COMPLETA**.
- Rama nueva `claude/auditoria-29` sobre `master` = `7bcc319`.
- `npm ci` → exit 0 (el clon de la nube no traía `node_modules`). INFRA resuelta.
- **Línea base de la compuerta**, medida sobre `7bcc319`:
  - `npm test` → **935 archivos, 12,536 pruebas pasan, 6 saltadas, 0 fallan**,
    exit 0, 138.74s.
    **Las 5 fallas INFRA de la 28 (`listen EAFNOSUPPORT ::1` en
    `scripts/ci/e2e/proxy-local.test.ts`) YA NO OCURREN.** Hay que dictaminar a
    quién se acredita (candidato: `6beb5f5`, «IPv6 selectivo en CI», PRU-B4).
  - `npx tsc --noEmit -p .` → **exit 0**.
  - `npm run lint` → **exit 0, 0 errores, 154 avisos** (eran 156 en la 28).
- `docs/auditoria-29/MAPA.md` escrito con la ventana commit por commit.

## Fase 1 — los 12 auditores

Lanzados en un solo mensaje, contexto fresco, uno por rubro, ninguno toca código.

## Estado de producción — MEDIDO por el orquestador, no inferido

La 28 dejó abierto: «producción corre `4f94490` (3-sep, 231 commits atrás)
contra el esquema `0347`; publicar exige una mano humana». Verificado hoy
contra la API de GitHub, corrida **34212560163** (`salud-produccion.yml`,
schedule, 8-sep 09:54 UTC, `head_sha=7bcc319`), **en rojo**:

```
http=503 estado=degraded crons=degraded
migracion={"base":"0347","codigo":"0347","atras":0, ...}
desplegado=d56e626 ultimo_[deploy]=d56e626
Producción corre el último [deploy] (d56e626) o uno posterior.
cadencia: declarada=30min real=268min (corrida anterior: 2026-09-08T05:26:06Z)
Ya hay un issue abierto (#365); no se duplica.
```

Tres lecturas, y las tres importan:

1. **La deriva de esquema SE CERRÓ.** `base=0347`, `codigo=0347`, `atras=0`, y
   el cotejo dice que producción corre el último `[deploy]`. La mano humana
   ocurrió: el CRÍTICO estrella de la 28 (código viejo contra esquema nuevo, la
   RPC fiscal rota) **ya no aplica**. Se acredita a quien lo publicó, no a este
   repo.
2. **Producción sigue en rojo, por OTRA causa.** `crons=degraded` con HTTP 503.
   El pulso lleva rojo desde el 7-sep 19:20 (**issue #365 abierto ~15 h**). El
   #344 de la 28 lo cerró `javiercamarapp` a mano el 7-sep 18:12, y el pulso
   volvió a abrir uno solo una hora después: la cadena de alarma **funciona**.
3. **Producción corre `d56e626` y `master` va en `7bcc319`.** Los **43 commits**
   de arreglos de la auditoría 28 **no están publicados**: ninguno lleva la
   bandera en el asunto. Es exactamente el modo de falla silencioso que
   documenta CLAUDE.md — el push se ve normal en GitHub y el sitio se queda
   atrás sin avisar. **Publicar sigue siendo una mano humana.**

También medido: la cadencia real del pulso fue de **268 min** contra los 30
declarados (el medidor de OP-A2, `861d09d`, **funciona y avisó**).


## Fase 4 — arreglos (tope: 3 vueltas)

- **Vuelta 1 · `166310c` — FIS-C1 [CRÍTICO], RETENIDO.** La declaración manual
  del 15% de `/admin/flotas` ahora se coteja contra `tenant.regimen_fiscal`.
  Rojo→verde medido con `git stash` del arreglo (3 de 8 casos fallan sin él).
  Suite completa **936 archivos / 12,544 pasan / 0 fallan**, exit 0.
  De paso mordió un guardarraíl real: `normas_sincronizadas` exige que
  `usado_en_codigo` apunte a símbolos vivos porque ese texto viaja VERBATIM al
  prompt del agente contador. Se actualizaron las dos fichas y se regeneró el
  corpus (2 líneas de diff).
- **Vuelta 2 · `d232f83` — LEG-C1 [CRÍTICO], RETENIDO.** El aviso integral
  declara la transferencia de la ubicación del operador al proveedor de auxilio
  en carretera. Rojo→verde medido con `git stash` (8 de 9 casos fallan sin el
  arreglo). Suite **937 / 12,553 / 0 fallan**, exit 0; `lint:ratchet` 0 nuevos
  (mordió un `no-unused-vars` mío y se quitó antes de commitear).
