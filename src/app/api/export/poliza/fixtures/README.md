`poliza342_rpc.json` contiene exclusivamente datos sintéticos. Se capturó del resultado real de `supabase/tests/0342_poliza_revision_y_desglose.sql` en PostgreSQL 17 local con el esquema 0342: cierre por `guardar_liquidacion_tx`, revisión por `revisar_liquidacion`, lectura por `poliza_datos_tenant`. La transacción termina en rollback.

`salida.test.ts` consume la captura mediante el doble de transporte y ejecuta la ruta, clasificación y serialización reales. Esta captura comprueba el contrato; no sustituye ejecutar la prueba SQL tras una migración.

Para regenerarla en una base efímera propia que ya tenga las migraciones aplicadas, define `PGHOST` (socket UNIX local), `PGPORT` y `PGDATABASE` de esa base y ejecuta desde la raíz del repositorio:

```sh
psql -X -qAt -v ON_ERROR_STOP=1 -f supabase/tests/0342_poliza_revision_y_desglose.sql > /private/tmp/poliza342-captura-local.log
python3 - <<'PY'
import json
from pathlib import Path
log = Path('/private/tmp/poliza342-captura-local.log').read_text()
rows = json.loads(next(line for line in log.splitlines() if line.startswith('[{')))
assert len(rows) == 6
assert all(row['version'] == 342 for row in rows)
Path('src/app/api/export/poliza/fixtures/poliza342_rpc.json').write_text(json.dumps(rows, indent=2) + '\n')
PY
npx vitest run src/app/api/export/poliza/salida.test.ts
```

No ejecutar la fixture en producción ni reutilizar datos reales. Cambian UUID y fecha de ejecución al regenerar; son sintéticos y no determinan el resultado contable.
